/**
 * End-to-end lifecycle: record → pressure → tidy.
 *
 * A realistic little session (read, edit, failing test, passing test) is
 * archived, then a tidy pass under pressure assigns every evaluated event a
 * valid decision, logs the decisions, and keeps stats consistent.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeManager, sampleInput, cleanup, pressured } from './util.js';
import type { ContextManager } from '../src/core/context-manager.js';

describe('lifecycle: record → pressure → tidy', () => {
  let manager: ContextManager;
  let dir: string;

  beforeEach(async () => {
    ({ manager, dir } = await makeManager({ strategy: 'aggressive' }));
  });

  afterEach(async () => {
    await cleanup(dir, manager);
  });

  it('every event gets a valid decision and stats stay consistent', async () => {
    const inputs = [
      sampleInput({
        toolCallId: 'lc-read',
        toolName: 'Read',
        input: 'Read src/a.ts',
        result: 'const a = 1;\n',
      }),
      sampleInput({
        toolCallId: 'lc-edit',
        toolName: 'Edit',
        input: 'Edit src/a.ts',
        result: 'Edited src/a.ts',
      }),
      sampleInput({
        toolCallId: 'lc-fail',
        toolName: 'Bash',
        input: 'npm test',
        result: 'FAIL tests/a.test.ts\n83 passed, 1 failed',
        status: 'error',
      }),
      sampleInput({
        toolCallId: 'lc-pass',
        toolName: 'Bash',
        input: 'npm test',
        result: '84 passed, 0 failed',
        status: 'ok',
      }),
    ];
    for (const inp of inputs) {
      const rec = await manager.recordToolComplete(inp);
      assert.equal(rec.archived, true, `expected ${inp.toolCallId} to archive`);
    }

    pressured(manager, 's1');
    const tidy = await manager.maybeTidy('s1');

    assert.ok(tidy.evaluated > 0, 'expected tidy to evaluate events under pressure');
    for (const d of tidy.decisions) {
      assert.ok(
        d.decision === 'keep' || d.decision === 'capsule' || d.decision === 'evict',
        `invalid decision: ${d.decision}`,
      );
    }

    const logged = manager.db.listDecisions(100) as unknown as unknown[];
    assert.ok(logged.length > 0, 'expected decisions to be logged in the DB');

    const stats = manager.getStats();
    assert.equal(stats.counters['tools_archived'], 4);

    const events = manager.db.listEvents('s1', 10);
    assert.equal(events.length, 4);
  });
});
