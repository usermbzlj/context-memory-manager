/**
 * PRD §7 / §10: the deterministic fallback scorer is never trusted enough
 * to evict — its decisions are capped at CAPSULE no matter the strategy.
 *
 * Under the aggressive strategy a fallback score of 0.85 would clear the
 * 0.8 evict threshold; the engine must still capsule, never evict.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeManager,
  sampleInput,
  cleanup,
  getEventByCallId,
  pressured,
} from './util.js';
import type { ContextManager } from '../src/core/context-manager.js';

describe('fallback scorer never evicts', () => {
  let manager: ContextManager;
  let dir: string;

  beforeEach(async () => {
    // No providers configured => the conservative scorer is primary.
    ({ manager, dir } = await makeManager({ strategy: 'aggressive' }));
  });

  afterEach(async () => {
    await cleanup(dir, manager);
  });

  it('caps a 0.85 fallback score at capsule under aggressive', async () => {
    // Fallback score: 0.35 base + 0.25 (>48KB) + 0.15 (ok && age>10) +
    // 0.1 (>8KB && no salient) = 0.85 >= aggressive evict threshold 0.8.
    const big = sampleInput({
      toolCallId: 'big-noisy',
      input: 'echo hi',
      result: 'x'.repeat(50_000),
      status: 'ok',
    });
    await manager.recordToolComplete(big);
    // Advance the turn counter so the big event is old (age 11 > 10).
    for (let i = 0; i < 11; i++) {
      await manager.recordToolComplete(sampleInput({ toolCallId: `filler-${i}` }));
    }
    pressured(manager, 's1');

    const tidy = await manager.maybeTidy('s1');
    const decision = tidy.decisions.find((d) => d.toolCallId === 'big-noisy');

    assert.ok(decision, 'expected a decision for the big event');
    assert.equal(decision.score, 0.85);
    assert.equal(decision.decision, 'capsule');
    assert.notEqual(decision.decision, 'evict');
    const event = getEventByCallId(manager, 'big-noisy');
    assert.equal(event?.state, 'capsule');
    assert.ok(event?.capsuleId, 'capsuled event should reference a capsule');
  });

  it('still caps at capsule when the primary is the fallback itself', async () => {
    await cleanup(dir, manager);
    ({ manager, dir } = await makeManager({
      strategy: 'aggressive',
      retention: { scorer: 'conservative' },
    }));

    const big = sampleInput({
      toolCallId: 'big-noisy-2',
      input: 'echo hi',
      result: 'x'.repeat(50_000),
      status: 'ok',
    });
    await manager.recordToolComplete(big);
    for (let i = 0; i < 11; i++) {
      await manager.recordToolComplete(sampleInput({ toolCallId: `f2-${i}` }));
    }
    pressured(manager, 's1');

    const tidy = await manager.maybeTidy('s1');
    const decision = tidy.decisions.find((d) => d.toolCallId === 'big-noisy-2');
    assert.equal(decision?.decision, 'capsule');
  });
});
