import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { rowToToolEvent } from '../src/types.js';
import { eventProtectionReason } from '../src/core/protection.js';
import { MemoryService, sessionKey } from '../src/runtime/memory.js';
import { makeManager, cleanup } from './util.js';

async function fixture(t: TestContext) {
  const { manager, dir } = await makeManager();
  t.after(() => cleanup(dir, manager));
  const service = new MemoryService(manager, { agent: 'chain-test', workspaceId: dir });
  const capture = async (sessionId: string, toolCallId: string, toolName: string, input: string, result: string, status: 'ok' | 'error' = 'ok') => {
    const saved = await service.capture({ sessionId, toolCallId, toolName, input, result, status });
    assert.equal(saved.archived, true, saved.error ?? 'capture must archive');
    return service.event(saved.eventId!);
  };
  const edit = await capture('source', 'source-edit', 'Edit', 'src/a.ts', 'Edited src/a.ts');
  const failure = await capture('source', 'source-test', 'Bash', 'npm test', 'FAIL src/a.ts\n1 passed, 1 failed', 'error');
  const chain = manager.db.getChain(failure.chain_id!);
  assert.ok(chain);
  assert.equal(manager.db.getToolEvent(edit.id)!.chain_id, chain.id);
  return { manager, dir, service, capture, edit: service.event(edit.id), failure, chain };
}

test('target session activity creates its own chain and never mutates the recalled source chain', async t => {
  const { manager, service, capture, edit, chain } = await fixture(t);
  const original = { ...edit };
  const members = manager.db.getChainMembers(chain.id);
  const capsule = manager.db.getCapsule(chain.capsule_id!);
  await manager.recallEvent(edit.id, edit.agent, edit.workspace_id, sessionKey(service.scope, 'target'));
  const target = sessionKey(service.scope, 'target');
  assert.equal(manager.db.getEventView(edit.id, target)!.chain_id, null);
  assert.equal(manager.db.listEvents(target).find(row => row.id === edit.id)!.chain_id, null);
  assert.equal(await manager.linker.linkEvent(rowToToolEvent(manager.db.getEventView(edit.id, target)!)), null);
  const read = await capture('target', 'target-read', 'Read', 'src/a.ts', 'const a = 1;');
  assert.equal(read.chain_id, null);
  const localEdit = await capture('target', 'target-edit', 'Edit', 'src/a.ts', 'Edited src/a.ts');
  await capture('target', 'target-failure', 'Bash', 'npm test', '1 passed, 1 failed', 'error');
  await capture('target', 'target-pass', 'Bash', 'npm test', '2 passed, 0 failed');
  const targetChain = manager.db.getChain(manager.db.getToolEvent(localEdit.id)!.chain_id!);
  assert.ok(targetChain);
  assert.notEqual(targetChain.id, chain.id);
  assert.equal(targetChain.session_id, target);
  assert.equal(targetChain.status, 'completed');
  assert.equal(manager.db.getCapsule(targetChain.capsule_id!)!.frozen, 1);
  assert.deepEqual({ ...manager.db.getToolEvent(edit.id)! }, original);
  assert.deepEqual(manager.db.getChain(chain.id), chain);
  assert.deepEqual(manager.db.getChainMembers(chain.id), members);
  assert.deepEqual(manager.db.getCapsule(chain.capsule_id!), capsule);
});

test('chain member writes reject foreign agent, workspace and source session', async t => {
  const { manager, dir, capture, chain } = await fixture(t);
  const foreignSession = await capture('target', 'foreign-session', 'Read', 'src/a.ts', 'target evidence');
  const others = [
    { agent: 'other-agent', workspaceId: dir, sessionId: 'other-agent-session' },
    { agent: 'chain-test', workspaceId: dir + '/other-workspace', sessionId: 'other-workspace-session' },
  ];
  const foreignIds = [foreignSession.id];
  for (const [index, scope] of others.entries()) {
    const saved = await manager.recordToolComplete({ ...scope, toolCallId: 'foreign-' + index, toolName: 'Read', input: 'x', result: 'y', status: 'ok' });
    assert.equal(saved.archived, true, saved.error ?? 'capture must archive');
    foreignIds.push(saved.eventId!);
  }
  const before = manager.db.getChainMembers(chain.id);
  for (const id of foreignIds)
    assert.throws(() => manager.db.addChainMember(chain.id, id, before.length), /agent\/workspace\/session/);
  assert.deepEqual(manager.db.getChainMembers(chain.id), before);
});

test('target recall protection expires on its own turn counter regardless of source chain turns', async t => {
  const { manager, service, capture, edit, failure, chain } = await fixture(t);
  manager.db.updateToolEvent(edit.id, { turn: 99 });
  manager.db.updateToolEvent(failure.id, { turn: 100 });
  manager.db.run('UPDATE sessions SET current_turn=200 WHERE id=?', [chain.session_id]);
  const target = sessionKey(service.scope, 'target');
  await manager.recallEvent(edit.id, edit.agent, edit.workspace_id, target);
  for (let i = 0; i < 6; i++) await capture('target', 'filler-' + i, 'Glob', 'filler', 'tiny');
  const view = manager.db.getEventView(edit.id, target)!;
  assert.equal(view.protected_until_turn, 3);
  assert.equal(manager.db.getCurrentTurn(target), 6);
  assert.equal(eventProtectionReason(manager.db, view, 3), undefined);
  manager.retention.primary = { name: 'fixed-test-score', async score() { return 0.8; } };
  const decision = await manager.retention.decide(rowToToolEvent(view), { pressure: 1 });
  assert.equal(decision.decision, 'capsule');
  assert.equal(manager.db.getEventView(edit.id, target)!.state, 'capsule');
  assert.equal(manager.db.getToolEvent(edit.id)!.state, 'hot');
  assert.equal(manager.db.getToolEvent(edit.id)!.chain_id, chain.id);
});

test('legacy mixed chain members do not affect source-chain readers or foreign-view protection', async t => {
  const { manager, capture, chain } = await fixture(t);
  const foreign = await capture('target', 'legacy-foreign', 'Read', 'src/a.ts', 'target evidence');
  const before = manager.db.getChainMembers(chain.id);
  // An old archive can already contain a membership written by the earlier bug.
  manager.db.run('INSERT INTO chain_members(chain_id,event_id,position) VALUES(?,?,?)', [chain.id, foreign.id, before.length]);
  manager.db.updateToolEvent(foreign.id, { chain_id: chain.id });
  assert.deepEqual(manager.db.getChainMembers(chain.id), before);
  assert.deepEqual(manager.db.getChainEvents(chain.id).map(row => row.id), before);
  assert.equal(eventProtectionReason(manager.db, manager.db.getToolEvent(foreign.id)!, 3), undefined);
  assert.equal(manager.db.queryOne<{ n: number }>('SELECT count(*) AS n FROM chain_members WHERE chain_id=?', [chain.id])!.n, before.length + 1,
    'read-time isolation does not silently rewrite legacy archive metadata');
});

test('source-chain pins retain global and explicit session scopes on recalled evidence', async t => {
  const { manager, service, capture, edit, chain } = await fixture(t);
  const target = sessionKey(service.scope, 'target');
  await manager.recallEvent(edit.id, edit.agent, edit.workspace_id, target);
  for (let i = 0; i < 6; i++) await capture('target', 'pin-filler-' + i, 'Glob', 'filler', 'tiny');
  const targetReason = () => eventProtectionReason(manager.db, manager.db.getEventView(edit.id, target)!, 3);
  assert.equal(targetReason(), undefined, 'source-chain activity cannot protect an expired target view');
  await manager.pin({ chainId: chain.id });
  assert.equal(targetReason(), 'pinned');
  let scored = 0;
  manager.retention.primary = { name: 'fixed-test-score', async score() { scored++; return 0.8; } };
  const decision = await manager.retention.decide(rowToToolEvent(manager.db.getEventView(edit.id, target)!), { pressure: 1 });
  assert.equal(decision.decision, 'keep');
  assert.equal(decision.reason, 'pinned');
  assert.equal(scored, 0);
  await manager.unpin({ chainId: chain.id });
  assert.equal(targetReason(), undefined);
  await manager.pin({ chainId: chain.id }, { sessionId: chain.session_id });
  assert.equal(eventProtectionReason(manager.db, service.event(edit.id), 3), 'pinned');
  assert.equal(targetReason(), undefined, 'source-session pin must not leak into the target session');
  await manager.pin({ chainId: chain.id }, { sessionId: target });
  assert.equal(targetReason(), 'pinned');
  await manager.unpin({ chainId: chain.id }, { sessionId: target });
  assert.equal(targetReason(), undefined);
  assert.equal(eventProtectionReason(manager.db, service.event(edit.id), 3), 'pinned', 'removing target pin preserves the independent source pin');
  await manager.unpin({ chainId: chain.id });
  assert.equal(targetReason(), undefined);
  assert.equal(manager.db.getEventView(edit.id, target)!.chain_id, null);
  assert.equal(service.event(edit.id).chain_id, chain.id);
});

test('global source-chain pin restores a cached target view and unpin reuses the same cached bytes', async t => {
  const { manager, service, capture, chain } = await fixture(t);
  const raw = 'unchanging evidence\n'.repeat(2500);
  const original = await capture('source', 'source-long-read', 'Read', 'src/a.ts', raw);
  assert.equal(original.chain_id, chain.id);
  const target = sessionKey(service.scope, 'target');
  await manager.recallEvent(original.id, original.agent, original.workspace_id, target);
  for (let i = 0; i < 6; i++) await capture('target', 'cache-filler-' + i, 'Glob', 'filler', 'tiny');
  manager.db.updateEventView(original.id, target, { state: 'capsule' });
  const compact = await service.project(original.id, raw, 'history', 'target');
  assert.equal(compact.replaced, true, 'fresh source-chain activity is not inherited by the target view');
  const sourceChain = { ...manager.db.getChain(chain.id)! };
  const sourceMembers = manager.db.getChainMembers(chain.id);
  const sourceCapsule = manager.db.getCapsule(sourceChain.capsule_id!);
  await manager.pin({ chainId: chain.id }, { persistent: true });
  const restored = await service.transform('target', [{ eventId: original.id, output: compact.text }], { usedTokens: 1000, contextWindow: 200000 });
  assert.equal(restored.projections[0].text, raw);
  assert.equal(restored.projections[0].reason, 'protected');
  assert.equal(restored.projections[0].replaced, true);
  await manager.unpin({ chainId: chain.id });
  const reused = await service.transform('target', [{ eventId: original.id, output: raw }], { usedTokens: 1000, contextWindow: 200000 });
  assert.equal(reused.projections[0].text, compact.text);
  assert.equal(reused.projections[0].cacheHit, true);
  assert.equal(manager.db.getEventView(original.id, target)!.chain_id, null);
  assert.deepEqual({ ...manager.db.getToolEvent(original.id)! }, { ...original });
  assert.deepEqual({ ...manager.db.getChain(chain.id)! }, sourceChain);
  assert.deepEqual(manager.db.getChainMembers(chain.id), sourceMembers);
  assert.deepEqual(manager.db.getCapsule(sourceChain.capsule_id!), sourceCapsule);
  assert.equal(manager.db.queryOne<{ n: number }>('SELECT count(*) AS n FROM projection_cache')!.n, 1);
  assert.equal(service.status().historyBatches.length, 0);
});

test('an invalid legacy source-chain association cannot borrow its global pin', async t => {
  const { manager, capture, chain } = await fixture(t);
  const foreign = await capture('target', 'invalid-source-pin', 'Read', 'src/a.ts', 'target evidence');
  manager.db.run('INSERT INTO chain_members(chain_id,event_id,position) VALUES(?,?,?)', [chain.id, foreign.id, 2]);
  manager.db.updateToolEvent(foreign.id, { chain_id: chain.id });
  await manager.pin({ chainId: chain.id });
  assert.equal(eventProtectionReason(manager.db, manager.db.getToolEvent(foreign.id)!, 3), undefined);
});
