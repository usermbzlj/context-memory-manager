/**
 * PRD §23: archive GC enforces retentionDays / maxSizeBytes and only ever
 * removes COLD data — never hot events, never capsule state, never pinned
 * or recall-protected events. Blob files are deleted only when no remaining
 * event references their content hash.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  makeManager,
  sampleInput,
  cleanup,
  getEventByCallId,
  useJevPrimary,
  pressured,
} from './util.js';
import type { ContextManager } from '../src/core/context-manager.js';
import { eventProtectionReason } from '../src/core/protection.js';

describe('archive gc', () => {
  let manager: ContextManager;
  let dir: string;

  beforeEach(async () => {
    ({ manager, dir } = await makeManager());
  });

  afterEach(async () => {
    await cleanup(dir, manager);
  });

  it('is a no-op when no retention caps are configured', async () => {
    await manager.recordToolComplete(sampleInput({ toolCallId: 'g0' }));
    const res = await manager.gc();
    assert.deepEqual(res, { deletedEvents: 0, freedBytes: 0, blobsDeleted: 0 });
    assert.ok(getEventByCallId(manager, 'g0'));
  });

  it('deletes only evicted events older than retentionDays', async () => {
    await cleanup(dir, manager);
    ({ manager, dir } = await makeManager({
      strategy: 'aggressive',
      storage: { retentionDays: 30 },
    }));

    await manager.recordToolComplete(sampleInput({ toolCallId: 'evict-me' }));
    await manager.recordToolComplete(sampleInput({ toolCallId: 'stay-hot' }));
    useJevPrimary(manager, '{"scores":[0.99,0.1]}');
    pressured(manager, 's1');
    await manager.maybeTidy('s1');
    assert.equal(getEventByCallId(manager, 'evict-me')?.state, 'evicted');
    assert.equal(getEventByCallId(manager, 'stay-hot')?.state, 'hot');

    // Backdate only the evicted event past the retention window.
    const old = Date.now() - 31 * 86_400_000;
    manager.db.run('UPDATE tool_events SET archived_at = ? WHERE tool_call_id = ?', [
      old,
      'evict-me',
    ]);

    const res = await manager.gc();
    assert.equal(res.deletedEvents, 1);
    assert.equal(getEventByCallId(manager, 'evict-me'), undefined);
    assert.ok(getEventByCallId(manager, 'stay-hot'), 'hot event must survive');
  });

  it('skips pinned and recall-protected evicted events', async () => {
    await cleanup(dir, manager);
    ({ manager, dir } = await makeManager({
      strategy: 'aggressive',
      storage: { retentionDays: 30 },
    }));

    for (const id of ['p1', 'p2']) {
      await manager.recordToolComplete(sampleInput({ toolCallId: id }));
    }
    useJevPrimary(manager, '{"scores":[0.99,0.99]}');
    pressured(manager, 's1');
    await manager.maybeTidy('s1');
    assert.equal(getEventByCallId(manager, 'p1')?.state, 'evicted');

    await manager.pin(
      { toolCallId: 'p1', agent: 'test-agent', workspaceId: '/test/ws' },
      { sessionId: 's1' },
    );
    const old = Date.now() - 31 * 86_400_000;
    manager.db.run('UPDATE tool_events SET archived_at = ?', [old]);

    const res = await manager.gc();
    assert.equal(res.deletedEvents, 1, 'only the unpinned evicted event goes');
    assert.ok(getEventByCallId(manager, 'p1'), 'pinned evicted event survives');
    assert.equal(getEventByCallId(manager, 'p2'), undefined);
  });

  it('never deletes capsule-state events', async () => {
    await cleanup(dir, manager);
    ({ manager, dir } = await makeManager({
      strategy: 'aggressive',
      storage: { retentionDays: 30 },
    }));

    await manager.recordToolComplete(sampleInput({ toolCallId: 'cap-me' }));
    useJevPrimary(manager, '{"scores":[0.6]}');
    pressured(manager, 's1');
    await manager.maybeTidy('s1');
    assert.equal(getEventByCallId(manager, 'cap-me')?.state, 'capsule');

    const old = Date.now() - 31 * 86_400_000;
    manager.db.run('UPDATE tool_events SET archived_at = ?', [old]);

    const res = await manager.gc();
    assert.equal(res.deletedEvents, 0);
    assert.ok(getEventByCallId(manager, 'cap-me'));
  });

  it('keeps truly evicted evidence when its source chain becomes active again until freshness expires', async () => {
    manager.config.storage.maxSizeBytes = 1;
    await manager.recordToolComplete(sampleInput({ toolCallId: 'chain-edit', toolName: 'Edit', input: 'src/a.ts', result: 'Edited src/a.ts' }));
    await manager.recordToolComplete(sampleInput({ toolCallId: 'chain-test', input: 'npm test', result: '1 passed, 1 failed', status: 'error' }));
    await manager.recordToolComplete(sampleInput({ toolCallId: 'old-read', toolName: 'Read', input: 'src/a.ts', result: 'important evidence' }));
    for (let i = 0; i < 18; i++) {
      await manager.recordToolComplete(sampleInput({ toolCallId: `age-${i}`, toolName: 'Glob', input: 'no-path', result: 'tiny' }));
    }
    const old = getEventByCallId(manager, 'old-read')!;
    assert.ok(old.chainId);
    assert.equal(eventProtectionReason(manager.db, manager.db.getToolEvent(old.id)!, 3), undefined);
    manager.retention.primary = { name: 'fixed-test-score', async score() { return 1; } };
    const decision = await manager.retention.decide(old, { pressure: 1 });
    assert.equal(decision.decision, 'evict', 'the old evidence must be evicted by the real retention path');
    await manager.recordToolComplete(sampleInput({ toolCallId: 'current-read', toolName: 'Read', input: 'src/a.ts', result: 'working again' }));
    assert.equal(getEventByCallId(manager, 'current-read')?.chainId, old.chainId);
    assert.equal(getEventByCallId(manager, 'old-read')?.state, 'evicted');
    assert.equal(eventProtectionReason(manager.db, manager.db.getToolEvent(old.id)!, 3), 'chain-active');
    assert.equal((await manager.gc()).deletedEvents, 0);
    assert.equal((await manager.archive.fetchOriginal(old.id)).result, 'important evidence');

    for (let i = 0; i < 4; i++) {
      await manager.recordToolComplete(sampleInput({ toolCallId: `expire-${i}`, toolName: 'Glob', input: 'no-path', result: 'tiny' }));
    }
    assert.equal(eventProtectionReason(manager.db, manager.db.getToolEvent(old.id)!, 3), undefined);
    assert.equal((await manager.gc()).deletedEvents, 1, 'inactive unpinned evidence becomes eligible again');
    assert.equal(manager.db.getToolEvent(old.id), undefined);
  });

  it('removes blob files only when no event references them', async () => {
    await cleanup(dir, manager);
    ({ manager, dir } = await makeManager({
      strategy: 'aggressive',
      storage: { retentionDays: 30 },
    }));

    // Two evicted events sharing one identical large result => one blob.
    const big = 'z'.repeat(20_000);
    await manager.recordToolComplete(
      sampleInput({ toolCallId: 'd1', result: big }),
    );
    await manager.recordToolComplete(
      sampleInput({ toolCallId: 'd2', result: big }),
    );
    useJevPrimary(manager, '{"scores":[0.99,0.99]}');
    pressured(manager, 's1');
    await manager.maybeTidy('s1');
    assert.equal(getEventByCallId(manager, 'd1')?.state, 'evicted');
    assert.equal(getEventByCallId(manager, 'd2')?.state, 'evicted');

    const event = getEventByCallId(manager, 'd1');
    const row = event && manager.db.getToolEvent(event.id);
    assert.ok(row && row.result_kind === 'blob');
    const blobPath = path.join(dir, 'blobs', row.result_ref);
    assert.ok(fs.existsSync(blobPath), 'blob file should exist before gc');

    const old = Date.now() - 31 * 86_400_000;
    manager.db.run('UPDATE tool_events SET archived_at = ?', [old]);

    const res = await manager.gc();
    assert.equal(res.deletedEvents, 2);
    assert.equal(res.blobsDeleted, 1, 'one shared blob deleted once');
    assert.ok(!fs.existsSync(blobPath), 'blob file removed after gc');
  });

  it('maxSizeBytes deletes oldest evicted first until under the cap', async () => {
    await cleanup(dir, manager);
    ({ manager, dir } = await makeManager({
      strategy: 'aggressive',
      storage: { maxSizeBytes: 1600 },
    }));

    // 6 events (~507 bytes each); aggressive protection (2 turns) lets the
    // oldest 4 evict while the newest 2 stay hot.
    for (let i = 0; i < 6; i++) {
      await manager.recordToolComplete(
        sampleInput({ toolCallId: `s-${i}`, result: 'y'.repeat(500) }),
      );
    }
    useJevPrimary(manager, '{"scores":[0.99,0.99,0.99,0.99,0.99,0.99]}');
    pressured(manager, 's1');
    await manager.maybeTidy('s1');
    for (let i = 0; i < 6; i++) {
      assert.equal(getEventByCallId(manager, `s-${i}`)?.state, 'evicted');
    }

    const res = await manager.gc();
    assert.ok(res.deletedEvents > 0, 'expected some deletions');
    assert.ok(
      manager.db.sumEventBytes() <= 1600,
      `bytes ${manager.db.sumEventBytes()} should be under cap`,
    );
    // Oldest-evicted-first: the newest evicted event is the last to go.
    assert.ok(
      getEventByCallId(manager, 's-3'),
      'newest evicted event survives longest',
    );
    assert.equal(
      getEventByCallId(manager, 's-0'),
      undefined,
      'oldest evicted event goes first',
    );
  });
});
