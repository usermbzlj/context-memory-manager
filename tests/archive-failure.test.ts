/**
 * PRD §47 invariant: archive failure ⇒ KEEP.
 *
 * If the archive write fails, the event must never enter management:
 * nothing is recorded, nothing becomes eligible for compaction, and the
 * manager keeps working afterwards.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeManager, sampleInput, cleanup, getEventByCallId } from './util.js';
import type { ContextManager } from '../src/core/context-manager.js';

describe('archive failure ⇒ KEEP (never compact what was not archived)', () => {
  let manager: ContextManager;
  let dir: string;

  beforeEach(async () => {
    ({ manager, dir } = await makeManager());
  });

  afterEach(async () => {
    await cleanup(dir, manager);
  });

  it('a failed archive records nothing and compacts nothing', async () => {
    manager.archive.failNextArchive();

    const input = sampleInput({ toolCallId: 'doomed' });
    const rec = await manager.recordToolComplete(input);

    assert.equal(rec.archived, false);
    assert.equal(rec.eventId, null);
    assert.equal(rec.internal, false);
    // Nothing to manage ⇒ nothing compacted: no row exists at all.
    assert.equal(getEventByCallId(manager, 'doomed'), undefined);
  });

  it('the manager keeps working after an archive failure', async () => {
    manager.archive.failNextArchive();
    await manager.recordToolComplete(sampleInput({ toolCallId: 'doomed' }));

    const rec = await manager.recordToolComplete(sampleInput({ toolCallId: 'fine' }));
    assert.equal(rec.archived, true);
    assert.ok(rec.eventId);
    assert.ok(getEventByCallId(manager, 'fine'));
  });
});
