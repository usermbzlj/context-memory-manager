/**
 * PRD §4.4 / §40: the tidy loop scores in bounded batches and loops to
 * release.
 *
 * With more HOT events than the per-pass batch cap, tidy must run multiple
 * passes (one model call per pass), accumulate decisions across passes, and
 * report the pass count. Events never evaluated stay HOT (implicit keep).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeManager,
  sampleInput,
  cleanup,
  getEventByCallId,
  useJevPrimary,
  pressured,
} from './util.js';
import type { ContextManager } from '../src/core/context-manager.js';

describe('tidy loops to release in bounded batches', () => {
  let manager: ContextManager;
  let dir: string;

  beforeEach(async () => {
    ({ manager, dir } = await makeManager({ strategy: 'aggressive' }));
  });

  afterEach(async () => {
    await cleanup(dir, manager);
  });

  it('scores 16 hot events in 2 passes with one model call per pass', async () => {
    // 16 events > per-pass batch cap (8): two passes of 8. The canned batch
    // response must match the per-pass batch size, not the total.
    const scores = [0.95, 0.2, 0.95, 0.2, 0.95, 0.2, 0.95, 0.2];
    const ids: string[] = [];
    for (let i = 0; i < 16; i++) {
      const r = await manager.recordToolComplete(
        sampleInput({ toolCallId: `loop-tc-${i}` }),
      );
      ids.push(r.eventId as string);
    }
    useJevPrimary(manager, JSON.stringify({ scores }));
    pressured(manager, 's1');

    const tidy = await manager.maybeTidy('s1');

    assert.equal(tidy.passes, 2);
    assert.equal(tidy.evaluated, 16);
    assert.equal(tidy.decisions.length, 16);
    // One batched model call per pass, not one per event.
    assert.equal(manager.db.listProviderCalls(10).length, 2);
    // Each pass: 4 evict / 4 keep.
    assert.equal(tidy.evicted, 8);
    assert.equal(tidy.kept, 8);
    assert.equal(tidy.evicted + tidy.kept + tidy.capsuled, 16);
    for (const id of ids) {
      assert.ok(
        tidy.decisions.some((d) => d.eventId === id),
        `missing decision for ${id}`,
      );
    }
  });

  it('stops looping when pressure is already below the trigger', async () => {
    const input = sampleInput({ toolCallId: 'low-pressure-tc' });
    await manager.recordToolComplete(input);
    // No host usage reported and a tiny context: pressure stays low.
    const tidy = await manager.maybeTidy('s1');
    assert.equal(tidy.passes, 0);
    assert.equal(tidy.evaluated, 0);
    assert.equal(getEventByCallId(manager, 'low-pressure-tc')?.state, 'hot');
  });

  it('a pass that changes nothing stops the loop early', async () => {
    // All scores below the aggressive keep threshold (0.35): every event is
    // kept, so pass 1 changes nothing and no pass 2 runs. Exactly one batch
    // of 8 so the canned response matches the batch size.
    for (let i = 0; i < 8; i++) {
      await manager.recordToolComplete(sampleInput({ toolCallId: `keep-tc-${i}` }));
    }
    useJevPrimary(manager, JSON.stringify({ scores: new Array(8).fill(0.1) }));
    pressured(manager, 's1');

    const tidy = await manager.maybeTidy('s1');
    assert.equal(tidy.passes, 1);
    assert.equal(tidy.kept, 8);
    assert.equal(tidy.evicted, 0);
  });
});
