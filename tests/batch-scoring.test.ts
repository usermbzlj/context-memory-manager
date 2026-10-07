/**
 * PRD §10 / §40: Jev supports batched scoring — one model call for up to 8
 * events — and a whole-batch failure routes every item to the fallback.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rowToToolEvent } from '../src/types.js';
import { JevScorer } from '../src/scoring/jev.js';
import { FakeProvider } from '../src/providers/fake.js';
import {
  makeManager,
  sampleInput,
  cleanup,
  useJevPrimary,
  pressured,
} from './util.js';
import type { BatchScoreItem, ToolEvent } from '../src/types.js';
import type { ContextManager } from '../src/core/context-manager.js';

function itemsFor(manager: ContextManager, count: number): BatchScoreItem[] {
  const rows = manager.db.listEvents('s1', count);
  assert.equal(rows.length, count);
  const turn = manager.db.getCurrentTurn('s1');
  return rows.map((r) => {
    const event: ToolEvent = rowToToolEvent(r);
    return {
      event,
      ctx: {
        recentDescriptors: [],
        chainSummary: undefined,
        pressure: 0.6,
        currentTurn: turn,
      },
    };
  });
}

describe('jev batch scoring', () => {
  let manager: ContextManager;
  let dir: string;

  beforeEach(async () => {
    ({ manager, dir } = await makeManager());
  });

  afterEach(async () => {
    await cleanup(dir, manager);
  });

  it('scores a batch with a single provider call', async () => {
    for (let i = 0; i < 3; i++) {
      await manager.recordToolComplete(sampleInput({ toolCallId: `b-${i}` }));
    }
    const fake = new FakeProvider('batch-fake', '{"scores":[0.9,0.1,0.75]}');
    const jev = new JevScorer({
      providers: [fake],
      recordCall: (r) => manager.db.insertProviderCall(r),
      logger: manager.logger,
    });

    const scores = await jev.scoreBatch(itemsFor(manager, 3));
    assert.deepEqual(scores, [0.9, 0.1, 0.75]);
    // One batched model call, not three.
    assert.equal(manager.db.listProviderCalls(10).length, 1);
  });

  it('rejects a batch response with the wrong number of scores', async () => {
    await manager.recordToolComplete(sampleInput({ toolCallId: 'b0' }));
    await manager.recordToolComplete(sampleInput({ toolCallId: 'b1' }));
    const jev = new JevScorer({
      providers: [new FakeProvider('f', '{"scores":[0.5]}')],
      recordCall: (r) => manager.db.insertProviderCall(r),
      logger: manager.logger,
    });
    await assert.rejects(jev.scoreBatch(itemsFor(manager, 2)), /expected 2 scores/);
  });

  it('batch failure routes every event to the fallback scorer', async () => {
    await cleanup(dir, manager);
    ({ manager, dir } = await makeManager({ strategy: 'aggressive' }));
    for (let i = 0; i < 3; i++) {
      await manager.recordToolComplete(sampleInput({ toolCallId: `fb-${i}` }));
    }
    // Invalid JSON => the whole batch call fails => fallback per event.
    useJevPrimary(manager, 'not-json{{{');
    pressured(manager, 's1');

    const tidy = await manager.maybeTidy('s1');
    assert.equal(tidy.evaluated, 3);
    for (const d of tidy.decisions) {
      const rows = manager.db.listScores(d.eventId, 1);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].scorer, 'conservative-fallback');
    }
  });

  it('scoreBatch with no providers throws (caller falls back)', async () => {
    await manager.recordToolComplete(sampleInput());
    const jev = new JevScorer({
      providers: [],
      recordCall: (r) => manager.db.insertProviderCall(r),
      logger: manager.logger,
    });
    await assert.rejects(jev.scoreBatch(itemsFor(manager, 1)), /no providers/);
  });
});
