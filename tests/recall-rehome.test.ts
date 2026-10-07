import { rowToToolEvent } from '../src/types.js';
/**
 * Cross-session recall re-homes the event into the recalling session so the
 * minimum-protection window runs on a live turn counter (PRD §7.3).
 * Recall without a session keeps the legacy behavior.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeManager,
  sampleInput,
  cleanup,
  getEventByCallId,
} from './util.js';
import type { ContextManager } from '../src/core/context-manager.js';

describe('recall session views', () => {
  let manager: ContextManager;
  let dir: string;

  beforeEach(async () => {
    ({ manager, dir } = await makeManager({ strategy: 'balanced' }));
  });

  afterEach(async () => {
    await cleanup(dir, manager);
  });

  it('recall into another session preserves source and creates a separate view', async () => {
    await manager.recordToolComplete(
      sampleInput({ toolCallId: 'rehome-me', input: 'ls', result: 'a\nb\n' }),
    );
    assert.equal(getEventByCallId(manager, 'rehome-me')?.sessionId, 's1');

    const recalled = await manager.recall('rehome-me', 'test-agent', '/test/ws', {
      sessionId: 's2',
    });
    assert.equal(recalled.toolCallId, 'rehome-me');
    assert.equal(recalled.result, 'a\nb\n');

    const source = getEventByCallId(manager, 'rehome-me');
    assert.equal(source?.sessionId, 's1');
    assert.equal(source?.turn, 1);
    const view = manager.db.getEventView(recalled.eventId, 's2');
    const after = view ? rowToToolEvent(view) : undefined;
    assert.equal(after?.sessionId, 's2');
    assert.equal(after?.state, 'hot');
    // Protection now runs on s2's turn counter (0 + 3).
    assert.equal(after?.protectedUntilTurn, 3);
    assert.equal(after?.turn, 0);
  });

  it('recall without a session keeps the legacy behavior', async () => {
    await manager.recordToolComplete(
      sampleInput({ toolCallId: 'stay-put', input: 'pwd', result: '/x\n' }),
    );
    const recalled = await manager.recall('stay-put', 'test-agent', '/test/ws');
    assert.equal(recalled.toolCallId, 'stay-put');

    const after = getEventByCallId(manager, 'stay-put');
    assert.equal(after?.sessionId, 's1');
    assert.equal(after?.state, 'hot');
    // turn 1 at record; protection = 1 + 3.
    assert.equal(after?.protectedUntilTurn, 4);
  });
});
