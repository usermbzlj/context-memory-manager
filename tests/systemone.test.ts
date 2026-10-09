import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import { defaultConfig, validateConfig } from '../src/config.js';
import { SystemOneProvider } from '../src/providers/systemone.js';
import { SystemOneScorer } from '../src/scoring/systemone.js';
import { rowToToolEvent, type BatchScoreItem, type CompletionResponse, type ModelProvider, type ToolEventInput } from '../src/types.js';
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
  async function items(count: number, overrides: Partial<ToolEventInput> = {}): Promise<BatchScoreItem[]> {
    const result: BatchScoreItem[] = [];
    for (let i = 0; i < count; i++) {
      const record = await manager.recordToolComplete(sampleInput({ input: `item ${i}`, toolCallId: `native-${i}`, ...overrides }));
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

const nativeRequest = '{"state":"hello","questions":{}}';

test('native HTTP transport aborts a server that never answers and refuses unauthenticated remote endpoints', async t => {
  let closed = 0;
  const f = await fixture(t, (_payload, response) => { response.on('close', () => { closed++; }); });
  const native = new SystemOneProvider(f.cfg);
  await assert.rejects(native.complete({ user: nativeRequest, timeoutMs: 50 }), /decision request timed out or was cancelled/);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(closed, 1, 'the in-flight request is actually aborted, not just abandoned');
  const remote = new SystemOneProvider({ ...f.cfg, baseUrl: 'https://example.invalid/v1' });
  await assert.rejects(remote.complete({ user: '{}' }), /no API key/);
  const cleartext = new SystemOneProvider({ ...f.cfg, baseUrl: 'http://192.0.2.1:9/v1', apiKey: 'sk-cleartext-secret' });
  await assert.rejects(cleartext.complete({ user: nativeRequest }), (error: Error) =>
    /credential refused over plain http/.test(error.message) && !error.message.includes('sk-cleartext-secret'));
});

test('native HTTP transport times out when headers arrive but the body stalls, and reports refused connections distinctly', async t => {
  let closed = 0;
  const f = await fixture(t, (_payload, response) => {
    response.on('close', () => { closed++; });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"model":"clef-flash-local","answers":');
  });
  const started = Date.now();
  await assert.rejects(new SystemOneProvider(f.cfg).complete({ user: nativeRequest, timeoutMs: 100 }), /timed out or was cancelled/);
  assert.ok(Date.now() - started < 3000);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(closed, 1);
  // A closed port is a plain failure, never mislabelled as a timeout.
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const refused = new SystemOneProvider({ ...f.cfg, baseUrl: `http://127.0.0.1:${port}/v1` });
  await assert.rejects(refused.complete({ user: nativeRequest, timeoutMs: 5000 }), error =>
    /decision request failed/.test((error as Error).message) && !/timed out/.test((error as Error).message));
});

test('native HTTP transport refuses redirects without forwarding the prompt or credentials, and oversized responses', async t => {
  const hits: { url: string; auth?: string }[] = [];
  const other = createServer((request, response) => { hits.push({ url: request.url!, auth: request.headers.authorization }); request.resume(); response.end('{}'); });
  await new Promise<void>(resolve => other.listen(0, '127.0.0.1', resolve));
  t.after(async () => { other.closeAllConnections(); await new Promise<void>(resolve => other.close(() => resolve())); });
  const otherPort = (other.address() as { port: number }).port;
  let mode: 'redirect' | 'oversize' | 'oversize-stream' = 'redirect';
  let status = 307;
  const f = await fixture(t, (_payload, response) => {
    if (mode === 'redirect') { response.writeHead(status, { location: `http://127.0.0.1:${otherPort}/stolen` }); response.end('PRIVATE_BODY'); return; }
    if (mode === 'oversize') { response.end('x'.repeat(300 * 1024)); return; }
    response.writeHead(200, { 'content-type': 'application/json' });
    const flood = setInterval(() => response.write('x'.repeat(64 * 1024)), 1);
    response.on('close', () => clearInterval(flood));
  });
  const keyed = new SystemOneProvider({ ...f.cfg, apiKey: 'sk-redirect-secret' });
  for (status of [301, 302, 307, 308]) {
    await assert.rejects(keyed.complete({ user: nativeRequest }), (error: Error) =>
      /redirect refused/.test(error.message) && !error.message.includes('PRIVATE_BODY') && !error.message.includes('sk-redirect-secret'));
  }
  assert.deepEqual(hits, []);
  for (mode of ['oversize', 'oversize-stream'] as const) {
    await assert.rejects(keyed.complete({ user: nativeRequest, timeoutMs: 5000 }), /response exceeds size limit/);
  }
});

test('Node 24 env proxy settings cannot capture native decision requests (default agent proxies, native transport does not)', async t => {
  const proxied: string[] = [];
  const modelUrls: string[] = [];
  const proxy = createServer((request, response) => { proxied.push(request.url!); request.resume(); response.end('{}'); });
  const model = createServer((request, response) => {
    modelUrls.push(request.url!); request.resume();
    response.end(JSON.stringify({ model: 'clef-flash-local', answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }));
  });
  for (const server of [proxy, model]) {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  }
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  const baseUrl = `http://127.0.0.1:${(model.address() as { port: number }).port}`;
  const moduleUrl = new URL('../src/providers/systemone.js', import.meta.url).href;
  const source = `import http from 'node:http';
    import { SystemOneProvider } from ${JSON.stringify(moduleUrl)};
    // Control: the default agent must be proxied here, otherwise this test proves nothing.
    await new Promise(resolve => { const call = http.request(process.env.MODEL_URL + '/probe', { method: 'POST' }, r => { r.resume(); r.on('end', resolve); }); call.on('error', resolve); call.end('{}'); });
    const native = new SystemOneProvider({ kind: 'systemone', name: 'native', model: 'm', baseUrl: process.env.MODEL_URL + '/v1' });
    const result = await native.complete({ user: ${JSON.stringify(nativeRequest)}, timeoutMs: 5000 });
    console.log(JSON.stringify({ tokensIn: result.tokensIn }));`;
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_USE_ENV_PROXY: '1', MODEL_URL: baseUrl };
  for (const name of ['HTTP_PROXY', 'http_proxy']) env[name] = proxyUrl;
  for (const name of ['NO_PROXY', 'no_proxy', 'ALL_PROXY', 'all_proxy']) delete env[name];
  const output = await new Promise<string>((resolve, reject) => {
    const peer = spawn(process.execPath, ['--input-type=module', '-e', source], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    peer.stdout.on('data', chunk => { out += chunk; });
    peer.stderr.on('data', chunk => { err += chunk; });
    peer.on('error', reject);
    peer.on('close', code => code === 0 ? resolve(out) : reject(new Error(err)));
  });
  if (!proxied.some(url => url.endsWith('/probe'))) { t.skip('this Node build ignores NODE_USE_ENV_PROXY'); return; }
  assert.deepEqual(JSON.parse(output), { tokensIn: 1 });
  assert.deepEqual(modelUrls, ['/v1/systemone'], 'the decision request reached the configured endpoint directly');
  assert.ok(!proxied.some(url => url.includes('systemone')), 'no decision request was routed through the proxy');
});

test('one overall deadline aborts in-flight native calls across providers; the whole batch falls back conservatively with archives intact', async t => {
  let closed = 0;
  const f = await fixture(t, (_payload, response) => { response.on('close', () => { closed++; }); });
  const items = await f.items(3);
  const scorer = new SystemOneScorer({ providers: [new SystemOneProvider(f.cfg), new SystemOneProvider({ ...f.cfg, name: 'second' })],
    recordCall: r => f.manager.db.insertProviderCall(r), logger: f.manager.logger, deadlineMs: 1000 });
  f.manager.retention.primary = scorer;
  const started = Date.now();
  const decisions = await f.manager.retention.decideAll(items.map(item => item.event), { pressure: 0.9 });
  assert.ok(Date.now() - started < 3000, 'bounded by the deadline, not by 30 s per provider');
  assert.equal(f.requests.length, 2, 'each provider receives a share of the deadline, so a stalled first one cannot starve the second');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(closed, 2, 'both in-flight HTTP requests were aborted');
  assert.equal(decisions.length, 3);
  for (const [index, item] of items.entries()) {
    assert.notEqual(decisions[index].decision, 'evict');
    assert.equal(f.manager.db.listScores(item.event.id, 1)[0].scorer, 'conservative-fallback');
    assert.equal((await f.manager.archive.fetchOriginal(item.event.id)).result, 'hi');
  }
  const calls = f.manager.db.listProviderCalls(10);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.ok === 0));
  // The deadline also bounds a provider that ignores cancellation entirely.
  const stuck: ModelProvider = { name: 'stuck', complete: () => new Promise(() => {}) };
  const ignoring = new SystemOneScorer({ providers: [stuck], recordCall: () => {}, logger: f.manager.logger, deadlineMs: 100 });
  await assert.rejects(ignoring.scoreBatch(items.slice(0, 1)), /all 1 providers failed: .*deadline/);
});

test('a pin landing while the provider call is in flight keeps the event; unpinned peers are still evicted', async t => {
  const f = await fixture(t, () => {});
  const [pinned, peer] = await f.items(2, { toolName: 'Read' });
  let release!: (response: CompletionResponse) => void;
  let started!: () => void;
  const hasStarted = new Promise<void>(resolve => { started = resolve; });
  const deferred: ModelProvider = { name: 'deferred', complete: () => { started(); return new Promise<CompletionResponse>(resolve => { release = resolve; }); } };
  f.manager.retention.primary = new SystemOneScorer({ providers: [deferred], recordCall: r => f.manager.db.insertProviderCall(r), logger: f.manager.logger });
  const pending = f.manager.retention.decideAll([pinned.event, peer.event], { pressure: 0.9 });
  await hasStarted;
  await f.manager.pin({ toolCallId: 'native-0', agent: pinned.event.agent, workspaceId: pinned.event.workspaceId });
  release({ model: 'clef-flash-local', tokensIn: 5, tokensOut: 0, text: JSON.stringify({ answers: {
    event_0: { type: 'noul', noul: 0.99 }, event_1: { type: 'noul', noul: 0.99 } } }) });
  const [first, second] = await pending;
  assert.equal(first.decision, 'keep');
  assert.equal(f.manager.db.getToolEvent(pinned.event.id)!.state, 'hot');
  assert.equal(second.decision, 'evict', 'control: without a pin the same score evicts');
  assert.equal((await f.manager.archive.fetchOriginal(pinned.event.id)).result, 'hi');
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
