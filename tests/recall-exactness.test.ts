/**
 * PRD §47 invariant: recall restores the EXACT original.
 *
 * Compaction only ever manages *visibility*: the archive always holds the
 * byte-identical input/result. Recall must restore them exactly (unicode,
 * newlines, tabs and all), promote the event back to hot, and protect it
 * from immediate re-compaction.
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

describe('recall restores the EXACT original', () => {
  let manager: ContextManager;
  let dir: string;

  beforeEach(async () => {
    ({ manager, dir } = await makeManager());
  });

  afterEach(async () => {
    await cleanup(dir, manager);
  });

  it('restores byte-identical input/result after eviction', async () => {
    // This leg needs the balanced strategy, so swap the beforeEach manager.
    await cleanup(dir, manager);
    ({ manager, dir } = await makeManager({ strategy: 'balanced' }));

    const original =
      'line one\nline two: 你好世界 🎉\n' + 'x'.repeat(8000) + '\nlast line with\ttab\n';
    const input = sampleInput({
      toolCallId: 'recall-me',
      input: 'cat /tmp/data.txt',
      result: original,
    });
    await manager.recordToolComplete(input);

    // Force eviction, then prove the event really left the hot layer.
    useJevPrimary(manager, '{"scores":[0.99]}');
    pressured(manager, 's1');
    await manager.maybeTidy('s1');
    assert.equal(getEventByCallId(manager, 'recall-me')?.state, 'evicted');

    const recalled = await manager.recall('recall-me', 'test-agent', '/test/ws');
    assert.equal(recalled.toolCallId, 'recall-me');
    assert.equal(recalled.input, input.input);
    assert.equal(recalled.result, original);

    const after = getEventByCallId(manager, 'recall-me');
    assert.equal(after?.state, 'hot');
    assert.equal(after?.recalledCount, 1);
    assert.ok(
      (after?.protectedUntilTurn ?? 0) > (after?.turn ?? 0),
      'recalled event must be protected from immediate re-compaction',
    );
  });

  it('recall works across sessions (no session scoping on recall)', async () => {
    await manager.recordToolComplete(
      sampleInput({ toolCallId: 'xsession', sessionId: 's1', result: 'session one result' }),
    );
    // Bump a second session forward so the recall happens "from" s2's perspective.
    await manager.recordToolComplete(
      sampleInput({ toolCallId: 'other', sessionId: 's2', result: 'session two' }),
    );

    const recalled = await manager.recall('xsession', 'test-agent', '/test/ws');
    assert.equal(recalled.toolCallId, 'xsession');
    assert.equal(recalled.result, 'session one result');
  });

  it('recall is isolated by agent: a wrong agent throws', async () => {
    await manager.recordToolComplete(
      sampleInput({ toolCallId: 'private', result: 'secret' }),
    );
    await assert.rejects(manager.recall('private', 'other-agent', '/test/ws'));
  });
});
