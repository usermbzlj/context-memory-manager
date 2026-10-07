/**
 * PRD §47 invariant: capsule failure ⇒ KEEP.
 *
 * If building a capsule throws, the event must not be evicted or left in a
 * half-compacted state: the decision degrades to KEEP and the event stays hot.
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

describe('capsule failure ⇒ KEEP (never destroy history)', () => {
  let manager: ContextManager;
  let dir: string;

  beforeEach(async () => {
    ({ manager, dir } = await makeManager({ strategy: 'balanced' }));
  });

  afterEach(async () => {
    await cleanup(dir, manager);
  });

  it('a failed capsule build degrades the decision to keep', async () => {
    // balanced: 0.5 <= 0.7 < 0.9 ⇒ this event would normally be capsuled.
    useJevPrimary(manager, '{"scores":[0.7]}');

    const input = sampleInput({
      toolCallId: 'err-1',
      input: 'npm test',
      // Padded with noise so the event's token load trips the pressure
      // trigger on its own (the JevScorer's canned 0.7 is unaffected).
      result:
        'FAIL tests/x.test.ts\nTypeError: boom\n    at Object.<anonymous> (src/x.ts:12:3)\n' +
        'noise\n'.repeat(350),
      status: 'error',
    });
    const rec = await manager.recordToolComplete(input);
    assert.ok(rec.eventId);
    const eventId = rec.eventId;

    // Arm the failure AFTER recording: the hook targets the next build, and
    // we want the tidy-time capsule build (not any record-time refresh) to fail.
    manager.capsules.failNextBuild();

    pressured(manager, 's1');
    const tidy = await manager.maybeTidy('s1');

    // decisions rows carry event_id (not tool_call_id); the in-memory
    // DecisionDetail carries both.
    const fromTidy = tidy.decisions.find((d) => d.toolCallId === 'err-1');
    const fromDb = manager.db.listDecisions(50).find((r) => r.event_id === eventId);
    const decision = fromTidy?.decision ?? fromDb?.decision;
    const reason = String(fromTidy?.reason ?? fromDb?.reason ?? '');

    assert.equal(decision, 'keep');
    assert.ok(
      reason.toLowerCase().includes('capsule'),
      `decision reason should mention the capsule failure, got: ${reason}`,
    );

    const ev = getEventByCallId(manager, 'err-1');
    assert.equal(ev?.state, 'hot');
  });
});
