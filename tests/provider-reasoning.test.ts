import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, validateConfig } from '../src/config.js';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.js';
import type { ProviderConfig } from '../src/types.js';

test('short JSON calls explicitly disable reasoning when configured and retain old request defaults', async t => {
  const requests: Record<string, unknown>[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return Response.json({ choices: [{ message: { content: '{"linked":false}' } }],
      usage: { prompt_tokens: 12, completion_tokens: 5 } });
  });
  const provider: ProviderConfig = { kind: 'openai-compatible', name: 'fixture', model: 'fixture',
    baseUrl: 'http://127.0.0.1:1234/v1' };
  const req = { user: 'Return JSON', jsonMode: true, maxTokens: 64 };
  const result = await new OpenAICompatibleProvider({ ...provider, reasoningEffort: 'none' }).complete(req);
  assert.equal(requests[0].reasoning_effort, 'none');
  assert.equal(requests[0].max_tokens, 64);
  assert.deepEqual(requests[0].response_format, { type: 'json_object' });
  assert.equal(JSON.parse(result.text).linked, false);
  assert.equal(result.tokensOut, 5);
  await new OpenAICompatibleProvider(provider).complete(req);
  assert.equal(Object.hasOwn(requests[1], 'reasoning_effort'), false);
});

test('reasoning config accepts explicit compatible-provider efforts and rejects invalid values or kinds', () => {
  const cfg = defaultConfig();
  const provider: ProviderConfig = { kind: 'openai-compatible', name: 'fixture', model: 'fixture' };
  for (const effort of ['none', 'low', 'medium', 'high', 'max'] as const) {
    cfg.providers.capsule = [{ ...provider, reasoningEffort: effort }];
    assert.equal(validateConfig(cfg).providers.capsule[0].reasoningEffort, effort);
  }
  for (const invalid of [null, 1, '', 'surprise']) {
    cfg.providers.capsule = [{ ...provider, reasoningEffort: invalid } as ProviderConfig];
    assert.throws(() => validateConfig(cfg), /reasoningEffort/);
  }
  cfg.providers.capsule = [{ ...provider, kind: 'anthropic', reasoningEffort: 'none' }];
  assert.throws(() => validateConfig(cfg), /reasoningEffort/);
});
