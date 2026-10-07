/**
 * PRD §47 invariant: scorer failover ⇒ conservative fallback.
 *
 * (a) When every provider fails, retention scoring must degrade to the
 *     deterministic conservative fallback: small ordinary events are KEPT
 *     (never evicted — the fallback score caps below the evict threshold).
 * (b) When a provider works, its score flows through the pipeline: a 0.99
 *     "safe to evict" score evicts a noisy event and is persisted in
 *     retention_scores.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeManager,
  sampleInput,
  cleanup,
  useJevPrimary,
  pressured,
} from './util.js';
import type { ContextManager } from '../src/core/context-manager.js';

describe('scorer failover ⇒ conservative fallback', () => {
  let manager: ContextManager;
  let dir: string;

  beforeEach(async () => {
    ({ manager, dir } = await makeManager({ strategy: 'balanced' }));
  });

  afterEach(async () => {
    await cleanup(dir, manager);
  });

  it('failed providers fall back: a small event is kept, never evicted', async () => {
    useJevPrimary(manager, '', 99); // provider always fails

    // ~2KB of ordinary output: enough managed token load to trip the
    // pressure trigger on its own, but far below every fallback-score bonus
    // threshold, so the conservative fallback still scores it ~0.35 (keep).
    const input = sampleInput({ toolCallId: 'small-ok', result: 'ok\n'.repeat(700) });
    await manager.recordToolComplete(input);

    pressured(manager, 's1');
    const tidy = await manager.maybeTidy('s1');

    const decision = tidy.decisions.find((d) => d.toolCallId === 'small-ok');
    assert.ok(decision, 'expected a tidy decision for the recorded event');
    assert.equal(decision.decision, 'keep');

    // The failed provider call was logged (ok = 0 / false).
    const calls = manager.db.listProviderCalls(50) as unknown as Array<
      Record<string, unknown>
    >;
    assert.ok(
      calls.some((c) => !c['ok']),
      'expected a failed provider_calls row',
    );
  });

  it('a working provider score flows through: 0.99 evicts a noisy event', async () => {
    useJevPrimary(manager, '{"scores":[0.99]}');

    const input = sampleInput({
      toolCallId: 'big-noisy',
      toolName: 'Read',
      input: 'build.log',
      result: 'noise\n'.repeat(4000) + 'done\n',
    });
    const rec = await manager.recordToolComplete(input);
    assert.ok(rec.eventId);
    const eventId = rec.eventId;

    pressured(manager, 's1');
    const tidy = await manager.maybeTidy('s1');

    const decision = tidy.decisions.find((d) => d.toolCallId === 'big-noisy');
    assert.ok(decision, 'expected a tidy decision for the noisy event');
    assert.equal(decision.decision, 'evict');

    // The score column is `safe_to_evict` in retention_scores.
    const scores = manager.db.listScores(eventId, 10);
    assert.ok(
      scores.some((s) => s.scorer === 'jev' && Math.abs(s.safe_to_evict - 0.99) < 1e-9),
      'expected a retention_scores row with scorer=jev and safe_to_evict=0.99',
    );
  });
});
