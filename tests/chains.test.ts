/**
 * Chain linking: a fix cycle touching one file is linked into a chain that
 * completes (with a frozen capsule) once the final test passes.
 *
 * Linker semantics (RuleChainLinker, verified empirically): a chain is born
 * at the first failure — or at a test command following a side-effect edit —
 * and later events join it via path overlap / test-after-edit / failure-fix
 * rules. Events recorded *before* the chain's birth cannot retroactively
 * join, so the opening edit stays unchained while the failure → investigate
 * → fix → green-test run shares one chain.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeManager, sampleInput, cleanup, getEventByCallId } from './util.js';
import type { ContextManager } from '../src/core/context-manager.js';

describe('chain linking across a fix cycle', () => {
  let manager: ContextManager;
  let dir: string;

  beforeEach(async () => {
    ({ manager, dir } = await makeManager());
  });

  afterEach(async () => {
    await cleanup(dir, manager);
  });

  it('links the failure→fix→pass run into a completed chain with a frozen capsule', async () => {
    const file = 'src/auth/token.ts';
    const seq = [
      sampleInput({
        toolCallId: 'ch-edit1',
        toolName: 'Edit',
        input: `Edit ${file}: use JWT_SECRET instead of JWT_SECRET_OLD in refreshToken()`,
        result: `Edited ${file} (1 change)`,
      }),
      sampleInput({
        toolCallId: 'ch-fail',
        toolName: 'Bash',
        input: 'npm test',
        result: `FAIL tests/auth.test.ts\nTypeError: validateToken is not a function\n    at Object.<anonymous> (${file}:417:22)\n83 passed, 1 failed`,
        status: 'error',
      }),
      sampleInput({
        toolCallId: 'ch-read',
        toolName: 'Read',
        input: `Read ${file} lines 400-430`,
        result: 'const claims = decodeClaims(token, JWT_SECRET);\n',
      }),
      sampleInput({
        toolCallId: 'ch-edit2',
        toolName: 'Edit',
        input: `Edit ${file}:417 use validateToken`,
        result: `Edited ${file} (1 change)`,
      }),
      sampleInput({
        toolCallId: 'ch-pass',
        toolName: 'Bash',
        input: 'npm test',
        result: '84 passed, 0 failed',
        status: 'ok',
      }),
    ];
    for (const inp of seq) {
      const rec = await manager.recordToolComplete(inp);
      assert.ok(rec.eventId, `expected ${inp.toolCallId} to archive`);
    }

    const byId = new Map(
      seq.map((inp) => [inp.toolCallId, getEventByCallId(manager, inp.toolCallId)]),
    );
    for (const [tc, ev] of byId) assert.ok(ev, `expected ${tc} to be recorded`);

    // The opening edit predates the chain's birth (first failure) and can
    // never retroactively join — documented linker behavior.
    assert.equal(byId.get('ch-edit1')?.chainId, byId.get('ch-fail')?.chainId, 'retain the initiating edit');

    // The remaining four share one chain.
    const memberIds = ['ch-fail', 'ch-read', 'ch-edit2', 'ch-pass'].map(
      (tc) => byId.get(tc)?.chainId,
    );
    assert.ok(memberIds[0], 'expected the failure to start a chain');
    assert.equal(new Set(memberIds).size, 1, `expected one shared chain, got ${JSON.stringify(memberIds)}`);

    const chains = manager.db.listChains('s1');
    const chain = chains.find((c) => c.id === memberIds[0]);
    assert.ok(chain, 'expected the chain row to exist');
    assert.equal(chain.status, 'completed', 'chain should complete on the green test');
    assert.ok(chain.capsule_id, 'expected a chain capsule');

    const cap = manager.db.listCapsules(20).find((c) => c.id === chain.capsule_id);
    assert.ok(cap, 'expected the chain capsule row');
    assert.ok(Number(cap.frozen) === 1, 'expected the chain capsule to be frozen');
    assert.equal(JSON.parse(cap.source_event_ids_json).length, 5, 'capsule provenance grows with chain membership');
  });
});
