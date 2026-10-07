/**
 * Archive idempotency: recording the same (agent, workspace, tool_call_id)
 * twice returns the existing event without a second row, a second turn
 * bump, or a second chain-linking pass.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeManager,
  sampleInput,
  cleanup,
} from './util.js';
import type { ContextManager } from '../src/core/context-manager.js';

describe('archive is idempotent on duplicate tool_call_id', () => {
  let manager: ContextManager;
  let dir: string;

  beforeEach(async () => {
    ({ manager, dir } = await makeManager());
  });

  afterEach(async () => {
    await cleanup(dir, manager);
  });

  it('second record returns the same event without duplicating', async () => {
    const input = sampleInput({ toolCallId: 'dup-1' });
    const first = await manager.recordToolComplete(input);
    assert.equal(first.archived, true);
    assert.ok(first.eventId);

    const second = await manager.recordToolComplete(input);
    assert.equal(second.archived, true);
    assert.equal(second.eventId, first.eventId);

    // Exactly one row for this tool_call_id.
    assert.equal(manager.db.listEvents('s1', 100).length, 1);
    // The turn was bumped only once (no double counting).
    assert.equal(manager.db.getCurrentTurn('s1'), 1);
  });

  it('duplicate detection is scoped to (agent, workspace, tool_call_id)', async () => {
    const a = await manager.recordToolComplete(
      sampleInput({ toolCallId: 'same-id', agent: 'agent-a' }),
    );
    const b = await manager.recordToolComplete(
      sampleInput({ toolCallId: 'same-id', agent: 'agent-b', sessionId: 'agent-b:s1' }),
    );
    assert.notEqual(a.eventId, b.eventId);
    assert.equal(a.archived, true);
    assert.equal(b.archived, true);
    assert.equal(manager.db.listEvents('s1', 100).length, 1);
    assert.equal(manager.db.listEvents('agent-b:s1', 100).length, 1);
  });
});
