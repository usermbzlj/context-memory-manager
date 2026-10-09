import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { GeminiProvider } from '../src/providers/gemini.js';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.js';
import { completeWithFailover, FAILOVER_DEADLINE_MS } from '../src/providers/failover.js';
import { MAX_RESPONSE_BYTES, type AbortableRequest } from '../src/providers/provider.js';
import { createLogger } from '../src/logging.js';
import type { ModelProvider, ProviderCallRecord, ProviderConfig } from '../src/types.js';

type Handler = (request: IncomingMessage, response: ServerResponse) => void;
async function listen(t: TestContext, handler: Handler): Promise<string> {
  const server = createServer((request, response) => { request.resume(); request.on('end', () => handler(request, response)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
const secret = 'sk-live-HARDENING-SECRET';
// Every fetch-based provider with the success body it expects.
const kinds = [
  { name: 'openai-compatible', make: (baseUrl: string) => new OpenAICompatibleProvider({ kind: 'openai-compatible', name: 'oa', model: 'm', baseUrl, apiKey: secret }),
    body: { choices: [{ message: { content: 'ok-text' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } } },
  { name: 'anthropic', make: (baseUrl: string) => new AnthropicProvider({ kind: 'anthropic', name: 'an', model: 'm', baseUrl, apiKey: secret } as ProviderConfig),
    body: { content: [{ type: 'text', text: 'ok-text' }], usage: { input_tokens: 3, output_tokens: 2 } } },
  { name: 'gemini', make: (baseUrl: string) => new GeminiProvider({ kind: 'gemini', name: 'ge', model: 'm', baseUrl, apiKey: secret } as ProviderConfig),
    body: { candidates: [{ content: { parts: [{ text: 'ok-text' }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } } },
];

for (const kind of kinds) {
  test(`${kind.name}: reads a normal JSON reply`, async t => {
    const baseUrl = await listen(t, (_request, response) => response.end(JSON.stringify(kind.body)));
    const result = await kind.make(baseUrl).complete({ user: 'hello', timeoutMs: 5000 });
    assert.equal(result.text, 'ok-text');
    assert.equal(result.tokensIn, 3);
    assert.equal(result.tokensOut, 2);
  });

  test(`${kind.name}: a credential is never sent over plain http to a non-loopback host`, async () => {
    // 192.0.2.0/24 is reserved documentation space; the refusal must happen before any connection.
    await assert.rejects(kind.make('http://192.0.2.1:9/v1').complete({ user: 'PRIVATE PROMPT', timeoutMs: 5000 }), (error: Error) =>
      error.name === 'ProviderError' && /credential refused over plain http/.test(error.message) && !error.message.includes(secret));
  });

  test(`${kind.name}: 3xx redirects are refused and neither the prompt nor credentials reach another host`, async t => {
    const stolen: { url: string; auth?: unknown; key?: unknown }[] = [];
    const other = await listen(t, (request, response) => {
      stolen.push({ url: request.url!, auth: request.headers.authorization, key: request.headers['x-api-key'] }); response.end('{}');
    });
    let status = 307;
    let posted = 0;
    const baseUrl = await listen(t, (_request, response) => {
      posted++; response.writeHead(status, { location: `${other}/stolen` }); response.end('PRIVATE_REDIRECT_BODY');
    });
    for (status of [301, 302, 307, 308]) {
      await assert.rejects(kind.make(baseUrl).complete({ user: 'PRIVATE PROMPT', timeoutMs: 5000 }), (error: Error) =>
        error.name === 'ProviderError' && /redirect refused/.test(error.message) &&
        !error.message.includes('PRIVATE_REDIRECT_BODY') && !error.message.includes(secret));
    }
    assert.equal(posted, 4);
    assert.deepEqual(stolen, []);
  });

  test(`${kind.name}: oversized replies (declared or streamed) are refused with no body in the error`, async t => {
    let mode: 'declared' | 'streamed' = 'declared';
    let closed = 0;
    const baseUrl = await listen(t, (_request, response) => {
      if (mode === 'declared') { response.end('PRIVATE_BIG' + 'x'.repeat(MAX_RESPONSE_BYTES + 10)); return; }
      response.on('close', () => { closed++; });
      response.writeHead(200, { 'content-type': 'application/json' });
      const flood = setInterval(() => response.write('PRIVATE_BIG' + 'x'.repeat(64 * 1024)), 1);
      response.on('close', () => clearInterval(flood));
    });
    for (mode of ['declared', 'streamed'] as const) {
      await assert.rejects(kind.make(baseUrl).complete({ user: 'hello', timeoutMs: 5000 }), (error: Error) =>
        /response exceeds size limit/.test(error.message) && !error.message.includes('PRIVATE_BIG'));
    }
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(closed, 1, 'the oversized stream is cancelled, not drained');
  });

  test(`${kind.name}: a reply that sends headers then stalls mid-body times out`, async t => {
    let closed = 0;
    const baseUrl = await listen(t, (_request, response) => {
      response.on('close', () => { closed++; });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"choices":[');
    });
    const started = Date.now();
    await assert.rejects(kind.make(baseUrl).complete({ user: 'hello', timeoutMs: 100 }), /request timed out or was cancelled/);
    assert.ok(Date.now() - started < 3000);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(closed, 1);
  });

  test(`${kind.name}: HTTP errors, invalid JSON and refused connections are distinct fixed-text failures`, async t => {
    let mode: 'status' | 'json' = 'status';
    const baseUrl = await listen(t, (_request, response) => {
      if (mode === 'status') { response.statusCode = 500; response.end('PRIVATE_ERROR_BODY ' + secret); return; }
      response.end('PRIVATE_NOT_JSON');
    });
    await assert.rejects(kind.make(baseUrl).complete({ user: 'hello' }), (error: Error) =>
      /HTTP 500 \(response body omitted\)/.test(error.message) && !/PRIVATE|sk-live/.test(error.message));
    mode = 'json';
    await assert.rejects(kind.make(baseUrl).complete({ user: 'hello' }), (error: Error) =>
      /invalid response JSON/.test(error.message) && !/PRIVATE/.test(error.message));
    const closed = createServer();
    await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address() as { port: number };
    await new Promise<void>(resolve => closed.close(() => resolve()));
    await assert.rejects(kind.make(`http://127.0.0.1:${port}`).complete({ user: 'hello', timeoutMs: 5000 }), (error: Error) =>
      /request failed/.test(error.message) && !/timed out|ECONNREFUSED|fetch failed/.test(error.message));
  });
}

test('failover applies one overall deadline across providers, aborting real I/O and bounding providers that ignore the signal', async () => {
  const records: ProviderCallRecord[] = [];
  const seen: AbortSignal[] = [];
  const hang = (name: string): ModelProvider => ({ name, complete: req => { seen.push((req as AbortableRequest).signal!); return new Promise(() => {}); } });
  const started = Date.now();
  await assert.rejects(completeWithFailover([hang('a'), hang('b')], { user: 'PRIVATE PROMPT', timeoutMs: 30000 },
    { purpose: 'retention', deadlineMs: 200, recordCall: r => records.push(r), logger: createLogger() }),
    /all 2 providers failed: .*deadline/);
  assert.ok(Date.now() - started < 3000);
  assert.ok(seen.length === 2 && seen.every(s => s.aborted), 'the signal reaches providers so their I/O is aborted');
  assert.deepEqual(records.map(r => [r.provider, r.ok]), [['a', false], ['b', false]]);
});

test('a stalled first provider only spends its share of the deadline, so the second provider still runs', async () => {
  for (const respectsSignal of [true, false]) {
    const records: ProviderCallRecord[] = [];
    let firstSignal: AbortSignal | undefined;
    const stalled: ModelProvider = { name: 'stalled', complete: req => {
      firstSignal = (req as AbortableRequest).signal;
      return new Promise((_, reject) => { if (respectsSignal) firstSignal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
    } };
    const second: ModelProvider = { name: 'second', async complete() { return { text: 'ok', tokensIn: 1, tokensOut: 1, model: 'x' }; } };
    const started = Date.now();
    const res = await completeWithFailover([stalled, second], { user: 'x', timeoutMs: 30000 },
      { purpose: 'retention', deadlineMs: 1000, recordCall: r => records.push(r), logger: createLogger() });
    assert.equal(res.text, 'ok');
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 400 && elapsed < 900, `first provider waited about half the budget, took ${elapsed}ms`);
    assert.equal(firstSignal?.aborted, true);
    assert.deepEqual(records.map(r => [r.provider, r.ok]), [['stalled', false], ['second', true]]);
  }
  // A single provider keeps the whole budget, and its own timeout still caps an attempt.
  let signal: AbortSignal | undefined;
  const only: ModelProvider = { name: 'only', complete: req => { signal = (req as AbortableRequest).signal; return new Promise(() => {}); } };
  const started = Date.now();
  await assert.rejects(completeWithFailover([only], { user: 'x', timeoutMs: 100 }, { purpose: 'retention', deadlineMs: 5000, recordCall: () => {}, logger: createLogger() }), /deadline/);
  assert.ok(Date.now() - started < 1000 && signal?.aborted);
});

test('failover honours a caller cancellation signal and keeps per-purpose default deadlines bounded', async () => {
  const controller = new AbortController();
  const hung: ModelProvider = { name: 'hung', complete: () => new Promise(() => {}) };
  setTimeout(() => controller.abort(), 30);
  const request: AbortableRequest = { user: 'x', signal: controller.signal };
  await assert.rejects(completeWithFailover([hung], request, { purpose: 'capsule', recordCall: () => {}, logger: createLogger() }), /deadline exceeded or cancelled/);
  assert.equal(FAILOVER_DEADLINE_MS.retention, 20_000);
  assert.ok(FAILOVER_DEADLINE_MS.capsule <= 60_000 && FAILOVER_DEADLINE_MS.chain <= 60_000);
});
