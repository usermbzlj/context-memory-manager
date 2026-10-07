/**
 * PRD §47 invariant: side-effect tools are never silently evicted.
 *
 * Even with a 0.99 "safe to evict" score, a mutating tool (Edit) must be
 * compacted to at most a capsule: the summary stays visible, a capsule row
 * exists, and the exact original remains fetchable from the archive.
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

describe('side-effect tools are never silently evicted (≥ capsule)', () => {
  let manager: ContextManager;
  let dir: string;

  beforeEach(async () => {
    ({ manager, dir } = await makeManager({ strategy: 'balanced' }));
  });

  afterEach(async () => {
    await cleanup(dir, manager);
  });

  it('a 0.99-scored Edit is capsuled, never evicted', async () => {
    const input = sampleInput({
      toolCallId: 'edit-1',
      toolName: 'Edit',
      input: 'Edit src/a.ts: rename foo -> bar',
      // Padded so the event's token load trips the pressure trigger on its own.
      result: 'Edited src/a.ts (1 change)\n' + 'diff --git a/src/a.ts b/src/a.ts\n'.repeat(40),
      status: 'ok',
    });
    const rec = await manager.recordToolComplete(input);
    assert.ok(rec.eventId);

    useJevPrimary(manager, '{"scores":[0.99]}');
    pressured(manager, 's1');
    const tidy = await manager.maybeTidy('s1');

    const decision = tidy.decisions.find((d) => d.toolCallId === 'edit-1');
    assert.ok(decision, 'expected a tidy decision for the Edit event');
    assert.equal(decision.decision, 'capsule');

    const ev = getEventByCallId(manager, 'edit-1');
    assert.equal(ev?.state, 'capsule');
    assert.ok(ev?.capsuleId, 'expected a capsule id on the event');

    const caps = manager.db.listCapsules(10) as unknown as Array<
      Record<string, unknown>
    >;
    assert.ok(
      caps.some((c) => String(c['id']) === ev?.capsuleId),
      'expected the capsule row to exist',
    );

    // The exact original is still fetchable from the archive.
    const orig = await manager.archive.fetchOriginal(rec.eventId as string);
    assert.equal(orig.input, input.input);
    assert.equal(orig.result, input.result);
  });
});
