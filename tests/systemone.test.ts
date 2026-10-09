import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { defaultConfig, validateConfig } from '../src/config.js';
import { SystemOneProvider } from '../src/providers/systemone.js';
import { rowToToolEvent, type BatchScoreItem } from '../src/types.js';
import { makeManager, cleanup, sampleInput, pressured } from './util.js';

async function fixture(t: TestContext, reply: (payload: any, response: ServerResponse) => void) {
  const requests: { url: string; payload: any }[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push({ url: request.url!, payload });
      reply(payload, response);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address() as { port: number };
  const cfg = { kind: 'systemone' as const, name: 'native-fixture', model: 'clef-flash-local', baseUrl: `http://127.0.0.1:${address.port}/v1` };
  const { manager, dir } = await makeManager({ retention: { scorer: 'systemone' }, providers: { retention: [cfg] } });
  t.after(() => cleanup(dir, manager));
  async function items(count: number): Promise<BatchScoreItem[]> {
    const result: BatchScoreItem[] = [];
    for (let i = 0; i < count; i++) {
      const record = await manager.recordToolComplete(sampleInput({ input: `item ${i}`, toolCallId: `native-${i}` }));
      result.push({ event: rowToToolEvent(manager.db.getToolEvent(record.eventId!)!),
        ctx: { currentTurn: 100, pressure: 0.8, recentDescriptors: [], taskHint: 'Fix the active connection error.' } });
    }
    return result;
  }
  return { cfg, manager, requests, items };
}
function respond(response: ServerResponse, answers: Record<string, unknown>) {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ model: 'clef-flash-local', answers, usage: { input_tokens: 77, output_tokens: 0 } }));
}

test('native scorer sends state/questions directly, preserves probability order and logs actual usage', async t => {
  const f = await fixture(t, (_payload, response) => respond(response, {
    event_1: { type: 'noul', noul: 0.95 }, event_0: { type: 'noul', noul: 0.05 },
  }));
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
    const before = process.env[name];
    process.env[name] = 'http://127.0.0.1:1';
    t.after(() => { if (before === undefined) delete process.env[name]; else process.env[name] = before; });
  }
  const scores = await f.manager.retention.primary.scoreBatch!(await f.items(2));
  assert.deepEqual(scores, [0.05, 0.95]);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, '/v1/systemone');
  assert.equal(f.requests[0].payload.messages, undefined);
  assert.equal(f.requests[0].payload.state.events[0].taskHint, 'Fix the active connection error.');
  const calls = f.manager.db.listProviderCalls(10);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tokens_in, 77);
  assert.equal(calls[0].tokens_out, 0);
  assert.equal(calls[0].purpose, 'retention');
  assert.equal(calls[0].ok, 1);
});

test('native scorer scores every event across bounded groups instead of dropping the batch tail', async t => {
  const f = await fixture(t, (payload, response) => respond(response, Object.fromEntries(
    payload.state.events.map((event: any) => [event.id, { type: 'noul', noul: Number(event.descriptor.inputSummary.match(/item (\d+)/)[1]) / 10 }]),
  )));
  assert.deepEqual(await f.manager.retention.primary.scoreBatch!(await f.items(10)), Array.from({ length: 10 }, (_, i) => i / 10));
  assert.ok(f.requests.length >= 2);
  for (const request of f.requests) assert.ok(request.payload.state.events.length <= 8);
});

test('missing, mismatched, nonnumeric or out-of-range native probabilities reject the whole group', async t => {
  let answers: Record<string, unknown> = {};
  const f = await fixture(t, (_payload, response) => respond(response, answers));
  const items = await f.items(1);
  for (const invalid of [{}, { wrong: { type: 'noul', noul: 0.4 } },
    { event_0: { type: 'noul', noul: '0.99' } }, { event_0: { type: 'noul', noul: 1.1 } },
    { event_0: { type: 'choice', noul: 0.99 } }]) {
    answers = invalid;
    await assert.rejects(f.manager.retention.primary.scoreBatch!(items), /all 1 providers failed/);
  }
  assert.ok(f.manager.db.listProviderCalls(10).every(call => call.ok === 0));
});

test('unavailable native decisions fail open through conservative retention and preserve exact archives', async t => {
  const f = await fixture(t, (_payload, response) => { response.statusCode = 503; response.end('PRIVATE_PROMPT_NOT_FOR_LOGS'); });
  const items = await f.items(2);
  pressured(f.manager, 's1');
  const tidy = await f.manager.maybeTidy('s1');
  assert.equal(tidy.evaluated, 2);
  assert.equal(tidy.evicted, 0);
  for (const item of items) {
    assert.equal(f.manager.db.listScores(item.event.id, 1)[0].scorer, 'conservative-fallback');
    assert.equal((await f.manager.archive.fetchOriginal(item.event.id)).result, 'hi');
  }
  assert.equal(f.requests.length, 1, 'A failed native request must not be retried');
  assert.ok(!JSON.stringify(f.manager.db.listProviderCalls(10)).includes('PRIVATE_PROMPT_NOT_FOR_LOGS'));
});

test('native HTTP transport aborts stalled responses and refuses unauthenticated remote endpoints', async t => {
  const f = await fixture(t, () => {});
  const native = new SystemOneProvider(f.cfg);
  await assert.rejects(native.complete({ user: '{"state":"hello","questions":{}}', timeoutMs: 25 }), /failed or timed out/);
  const remote = new SystemOneProvider({ ...f.cfg, baseUrl: 'https://example.invalid/v1' });
  await assert.rejects(remote.complete({ user: '{}' }), /no API key/);
});

test('oversized native inputs fail before a call and remain eligible for conservative fallback', async t => {
  const f = await fixture(t, (_payload, response) => respond(response, {}));
  const items = await f.items(1);
  items[0].event.descriptor.salient = ['x'.repeat(20000)];
  await assert.rejects(f.manager.retention.primary.scoreBatch!(items), /input budget/);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(await f.manager.retention.primary.scoreBatch!([]), []);
});

test('configuration rejects native decision providers in prose-generation roles or with a mismatched scorer', () => {
  const cfg = defaultConfig();
  const native = { kind: 'systemone' as const, name: 'local', model: 'clef-flash-local', baseUrl: 'http://127.0.0.1:18180/v1' };
  cfg.retention.scorer = 'systemone';
  cfg.providers.retention = [native];
  assert.equal(validateConfig(cfg), cfg);
  for (const purpose of ['capsule', 'chain'] as const) {
    const bad = structuredClone(cfg); bad.providers[purpose] = [native];
    assert.throws(() => validateConfig(bad), /retention-only/);
  }
  const wrong = structuredClone(cfg); wrong.retention.scorer = 'jev';
  assert.throws(() => validateConfig(wrong), /require retention.scorer/);
  const absent = structuredClone(cfg); delete absent.providers.retention[0].baseUrl;
  assert.throws(() => validateConfig(absent), /explicit baseUrl/);
});
