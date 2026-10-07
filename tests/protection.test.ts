import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { rowToToolEvent } from '../src/types.js';
import { eventProtectionReason } from '../src/core/protection.js';
import { MemoryService } from '../src/runtime/memory.js';
import { makeManager, cleanup } from './util.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t: TestContext) {
  const { manager, dir } = await makeManager();
  t.after(() => cleanup(dir, manager));
  const service = new MemoryService(manager, { agent: 'protection-test', workspaceId: dir });
  const raw = 'unchanging evidence\n'.repeat(5000);
  const saved = await service.capture({ sessionId: 's', toolCallId: 'old-read', toolName: 'Read', input: 'src/a.ts', result: raw });
  assert.equal(saved.archived, true, saved.error ?? 'capture must archive');
  const row = service.event(saved.eventId!);
  const chainId = 'same-session-chain';
  const now = Date.now();
  manager.db.insertChain({ id: chainId, agent: row.agent, workspace_id: row.workspace_id, session_id: row.session_id,
    status: 'active', capsule_id: null, created_at: now, updated_at: now });
  manager.db.addChainMember(chainId, row.id, 0);
  manager.db.updateToolEvent(row.id, { chain_id: chainId });
  for (let i = 0; i < 15; i++) {
    const filler = await service.capture({ sessionId: 's', toolCallId: 'filler-' + i, toolName: 'Glob', input: 'no-path', result: 'tiny' });
    assert.equal(filler.archived, true, filler.error ?? 'capture must archive');
  }
  assert.equal(eventProtectionReason(manager.db, service.event(row.id), 3), undefined);
  const reactivate = async () => {
    const fresh = await service.capture({ sessionId: 's', toolCallId: 'current-read', toolName: 'Read', input: 'src/a.ts', result: 'current work' });
    assert.equal(fresh.archived, true, fresh.error ?? 'capture must archive');
    assert.equal(service.event(fresh.eventId!).chain_id, chainId);
  };
  return { manager, service, id: row.id, row: service.event(row.id), raw, reactivate };
}

for (const action of ['chain', 'pin', 'recall', 'state'] as const) {
  test(`retention rechecks ${action} changes after a pending score`, async t => {
    const { manager, service, id, row, reactivate } = await fixture(t);
    const started = deferred<void>();
    const score = deferred<number>();
    manager.retention.primary = { name: 'delayed-test-score', async score() { started.resolve(); return score.promise; } };
    const pending = manager.retention.decide(rowToToolEvent(row), { pressure: 1 });
    await started.promise;
    try {
      if (action === 'chain') await reactivate();
      else if (action === 'pin') await service.pin(id, true);
      else if (action === 'recall') await manager.recallEvent(id, row.agent, row.workspace_id);
      else manager.db.updateToolEvent(id, { state: 'evicted' });
    } finally { score.resolve(0.8); }
    const decision = await pending;
    assert.equal(decision.decision, 'keep');
    assert.equal(decision.reason, { chain: 'chain-active', pin: 'pinned', recall: 'recall-protection', state: 'concurrent-state-change' }[action]);
    assert.equal(service.event(id).state, action === 'state' ? 'evicted' : 'hot');
    assert.equal(service.event(id).capsule_id, null);
  });
}

test('retention rechecks a chain that becomes active while its capsule is being built', async t => {
  const { manager, service, id, row, reactivate } = await fixture(t);
  const started = deferred<void>();
  const resume = deferred<void>();
  const build = manager.capsules.build.bind(manager.capsules);
  manager.capsules.build = async event => {
    const capsule = await build(event);
    started.resolve();
    await resume.promise;
    return capsule;
  };
  manager.retention.primary = { name: 'fixed-test-score', async score() { return 0.8; } };
  const pending = manager.retention.decide(rowToToolEvent(row), { pressure: 1 });
  await started.promise;
  try { await reactivate(); } finally { resume.resolve(); }
  const decision = await pending;
  assert.equal(decision.decision, 'keep');
  assert.equal(decision.reason, 'chain-active');
  assert.equal(service.event(id).state, 'hot');
  assert.equal(service.event(id).capsule_id, null);
});

test('a same-session chain becoming active restores its cached history view below pressure', async t => {
  const { manager, service, id, raw, reactivate } = await fixture(t);
  manager.db.updateToolEvent(id, { state: 'capsule' });
  const compact = await service.project(id, raw, 'history', 's');
  assert.equal(compact.replaced, true);
  assert.ok(compact.text.length < raw.length);
  await reactivate();
  const transformed = await service.transform('s', [{ eventId: id, output: compact.text }], { usedTokens: 1000, contextWindow: 200000 });
  assert.equal(transformed.projections.length, 1);
  assert.equal(transformed.projections[0].text, raw);
  assert.equal(transformed.projections[0].replaced, true);
  assert.equal(transformed.projections[0].reason, 'protected');
  assert.equal(manager.db.queryOne<{ n: number }>('SELECT count(*) AS n FROM projection_cache')!.n, 1);
  assert.equal(service.status().historyBatches.length, 0);
});
