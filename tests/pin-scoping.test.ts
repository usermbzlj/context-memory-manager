/**
 * PRD §24: pins are session-scoped. A pin recorded for session A must not
 * protect the event when it is tidied in session B; a global pin (no
 * session) protects everywhere.
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

const TARGET = 'scoped-target';

/** Re-home the target to s2 via recall, age s2 out of the protection
 *  windows, then pressure s2. Fillers use a different tool so the chain
 *  linker does not join them to the target's chain. */
async function setupCrossSession(
  manager: ContextManager,
): Promise<void> {
  await manager.recall(TARGET, 'test-agent', '/test/ws', { sessionId: 's2' });
  for (let i = 0; i < 4; i++) {
    await manager.recordToolComplete(
      sampleInput({ toolCallId: `s2-fill-${i}`, sessionId: 's2', toolName: 'Read' }),
    );
  }
  // 5 scorable events in s2: the target + 4 fillers.
  useJevPrimary(manager, '{"scores":[0.99,0.99,0.99,0.99,0.99]}');
  pressured(manager, 's2');
}

describe('pin session scoping', () => {
  let manager: ContextManager;
  let dir: string;

  beforeEach(async () => {
    ({ manager, dir } = await makeManager({ strategy: 'aggressive' }));
  });

  afterEach(async () => {
    await cleanup(dir, manager);
  });

  it('a pin for session s1 does not protect the event in session s2', async () => {
    await manager.recordToolComplete(sampleInput({ toolCallId: TARGET }));
    await manager.pin(
      { toolCallId: TARGET, agent: 'test-agent', workspaceId: '/test/ws' },
      { sessionId: 's1' },
    );
    await setupCrossSession(manager);

    const tidy = await manager.maybeTidy('s2');
    const decision = tidy.decisions.find((d) => d.toolCallId === TARGET);
    assert.ok(decision, 'expected a decision for the target');
    assert.equal(
      decision.decision,
      'evict',
      's1-scoped pin must not protect the event in s2',
    );
    const source = getEventByCallId(manager, TARGET);
    assert.equal(source?.state, 'hot', 'source view stays pinned');
    assert.equal(manager.db.getEventView(source!.id, 's2')?.state, 'evicted');
  });

  it('a global pin protects the event in every session', async () => {
    await manager.recordToolComplete(sampleInput({ toolCallId: TARGET }));
    await manager.pin(
      { toolCallId: TARGET, agent: 'test-agent', workspaceId: '/test/ws' },
      // no sessionId => global pin
    );
    await setupCrossSession(manager);

    const tidy = await manager.maybeTidy('s2');
    const decision = tidy.decisions.find((d) => d.toolCallId === TARGET);
    assert.equal(decision?.decision, 'keep');
    assert.equal(decision?.reason, 'pinned');
    assert.equal(getEventByCallId(manager, TARGET)?.state, 'hot');
  });

  it('the same event can be pinned in two sessions independently', async () => {
    await manager.recordToolComplete(sampleInput({ toolCallId: TARGET }));
    const target = { toolCallId: TARGET, agent: 'test-agent', workspaceId: '/test/ws' };
    await manager.pin(target, { sessionId: 's1' });
    await manager.pin(target, { sessionId: 's2' });

    const eventId = getEventByCallId(manager, TARGET)?.id as string;
    const pins = manager.db.listPinsForTarget('event', eventId);
    assert.equal(pins.length, 2);

    // Unpinning one session leaves the other intact.
    await manager.unpin(target, { sessionId: 's1' });
    const remaining = manager.db.listPinsForTarget('event', eventId);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].session_id, 's2');
    assert.equal(getEventByCallId(manager, TARGET)?.pinned, true);
  });
});
