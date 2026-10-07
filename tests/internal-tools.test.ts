/**
 * PRD §47 invariant: internal tools (`context_*`) are excluded from
 * management. They are audit-logged only — no tool_events row, no chain,
 * no retention scoring.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeManager, sampleInput, cleanup, getEventByCallId } from './util.js';
import type { ContextManager } from '../src/core/context-manager.js';

describe('internal tools (context_*) are audit-only', () => {
  let manager: ContextManager;
  let dir: string;

  beforeEach(async () => {
    ({ manager, dir } = await makeManager());
  });

  afterEach(async () => {
    await cleanup(dir, manager);
  });

  function auditCount(): number {
    const rows = manager.db.queryAll<{ n: number }>(
      'SELECT COUNT(*) AS n FROM audit_log',
    );
    return rows[0]?.n ?? 0;
  }

  it('context_recall is not recorded as a tool event but is audited', async () => {
    const before = auditCount();

    const rec = await manager.recordToolComplete(
      sampleInput({
        toolCallId: 'ctx-1',
        toolName: 'context_recall',
        input: 'recall e7-npm-install',
        result: 'restored 120KB',
      }),
    );

    assert.equal(rec.internal, true);
    assert.equal(getEventByCallId(manager, 'ctx-1'), undefined);
    assert.ok(auditCount() > before, 'expected the internal tool to be audit-logged');
  });
});
