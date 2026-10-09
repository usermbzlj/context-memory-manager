import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MemoryService } from '../src/runtime/memory.js';
import { mergeObservedProvenance, provenanceFor, type EvidenceProvenance } from '../src/evidence/provenance.js';
import { makeManager, cleanup } from './util.js';

const raw = 'evidence line\n'.repeat(9000);
const partial: EvidenceProvenance = {
  version: 1, origin: 'tool-observation', captureStage: 'host-result', completeness: 'partial', notes: ['Host reported metadata.truncated=true.'],
};
async function fixture(t: TestContext) {
  const { manager, dir } = await makeManager();
  t.after(() => cleanup(dir, manager));
  return { manager, dir, service: new MemoryService(manager, { agent: 'core', workspaceId: dir }) };
}
async function add(service: MemoryService, call: string, result = raw + call) {
  const saved = await service.capture({ sessionId: 's', toolCallId: call, toolName: 'Read', input: 'x', result });
  assert.equal(saved.archived, true, saved.error ?? 'capture failed');
  return saved.eventId!;
}

test('verify skips events retired by GC between rows but still reports real corruption', async t => {
  const { manager, service, dir } = await fixture(t);
  manager.config.storage.maxSizeBytes = 1;
  const ids = [await add(service, 'a'), await add(service, 'b'), await add(service, 'c')].sort();
  const [first, retiring, corrupt] = ids;
  manager.db.updateToolEvent(retiring, { state: 'evicted', protected_until_turn: 0 });
  const row = manager.db.getToolEvent(corrupt)!;
  assert.equal(row.result_kind, 'blob');
  fs.writeFileSync(path.join(dir, 'blobs', row.result_ref), 'corrupt');
  const fetch = manager.archive.fetchOriginal.bind(manager.archive);
  let retired = false;
  manager.archive.fetchOriginal = async eventId => {
    // Rows are visited in id order: retire the second one while the first read is in flight.
    const original = await fetch(eventId);
    if (eventId === first && !retired) { retired = true; assert.equal((await manager.gc()).deletedEvents, 1); }
    return original;
  };
  const result = await service.verify();
  assert.equal(manager.db.getToolEvent(retiring), undefined);
  assert.equal(result.checked, 1, 'the retired event is neither checked nor failed');
  assert.equal(result.failed, 1);
  assert.deepEqual(result.failures.map(f => f.eventId), [corrupt]);
});

test('verify skips projection receipts of events retired while receipts are being checked', async t => {
  const { manager, service } = await fixture(t);
  manager.config.storage.maxSizeBytes = 1;
  const keep = await add(service, 'keep'), retiring = await add(service, 'retiring');
  manager.db.updateToolEvent(keep, { state: 'capsule', protected_until_turn: 0 });
  manager.db.updateToolEvent(retiring, { state: 'capsule', protected_until_turn: 0 });
  for (const id of [keep, retiring]) assert.equal((await service.project(id, raw + (id === keep ? 'keep' : 'retiring'), 'history', 's')).replaced, true);
  manager.db.updateToolEvent(retiring, { state: 'evicted' });
  manager.db.run('DELETE FROM event_views');
  const fetch = manager.archive.fetchOriginal.bind(manager.archive);
  let calls = 0;
  manager.archive.fetchOriginal = async eventId => {
    const original = await fetch(eventId);
    // Two row reads precede the receipt loop; retire during the first receipt read.
    if (++calls === 3) assert.equal((await manager.gc()).deletedEvents, 1);
    return original;
  };
  const result = await service.verify();
  assert.equal(manager.db.getToolEvent(retiring), undefined);
  assert.equal(result.failed, 0, result.failures.map(f => f.error).join('; '));
  assert.equal(result.projectionFailed, 0);
  // A receipt whose event still exists is still verified (and fails when tampered).
  manager.db.run('UPDATE projection_cache SET visible_sha=? WHERE event_id=?', ['0'.repeat(64), keep]);
  manager.archive.fetchOriginal = fetch;
  assert.equal((await service.verify()).projectionFailed, 1);
});

test('history batch commit rechecks provenance and publishes only still-eligible events', async t => {
  const { manager, service } = await fixture(t);
  const a = await add(service, 'a'), b = await add(service, 'b');
  for (const id of [a, b]) manager.db.updateToolEvent(id, { state: 'capsule', protected_until_turn: 0 });
  const outputs = new Map([[a, raw + 'a'], [b, raw + 'b']]);
  const project = service.project.bind(service);
  let restricted: string | undefined;
  // A concurrent duplicate/observation lands after eligibility and projection but before the batch commit.
  service.project = async (id, ...rest) => {
    const p = await project(id, ...rest);
    if (!restricted) {
      restricted = id;
      const merged = mergeObservedProvenance(provenanceFor(manager.db, id), partial);
      manager.db.run('UPDATE evidence_provenance SET json=? WHERE event_id=?', [JSON.stringify(merged), id]);
    }
    return p;
  };
  const items = [{ eventId: a, output: outputs.get(a)! }, { eventId: b, output: outputs.get(b)! }];
  const result = await service.transform('s', items, { usedTokens: 90_000_000, contextWindow: 100_000_000 });
  assert.ok(restricted);
  const other = restricted === a ? b : a;
  assert.equal('policy' in result && result.policy?.reason, 'pressure-batch-published');
  assert.deepEqual(result.projections.map(p => p.eventId), [other]);
  assert.equal(manager.db.queryOne('SELECT 1 FROM projection_cache WHERE event_id=?', [restricted]), undefined, 'no receipt for partial evidence');
  assert.ok(manager.db.queryOne('SELECT 1 FROM projection_cache WHERE event_id=?', [other]));
  assert.equal(manager.db.queryOne<{ changed_events: number }>('SELECT changed_events FROM history_batches')!.changed_events, 1);
  assert.equal((await service.verify()).failed, 0);
});

test('history batch with only newly restricted evidence publishes nothing', async t => {
  const { manager, service } = await fixture(t);
  const id = await add(service, 'only');
  manager.db.updateToolEvent(id, { state: 'capsule', protected_until_turn: 0 });
  const project = service.project.bind(service);
  service.project = async (...args) => {
    const p = await project(...args);
    manager.db.run('UPDATE evidence_provenance SET json=? WHERE event_id=?', [JSON.stringify(mergeObservedProvenance(provenanceFor(manager.db, id), partial)), id]);
    return p;
  };
  const result = await service.transform('s', [{ eventId: id, output: raw + 'only' }], { usedTokens: 90_000_000, contextWindow: 100_000_000 });
  assert.equal('policy' in result && result.policy?.reason, 'batch-aborted-originals-kept');
  assert.deepEqual(result.projections, []);
  assert.equal(manager.db.queryOne<{ n: number }>('SELECT count(*) n FROM projection_cache')!.n, 0);
  assert.equal(manager.db.queryOne<{ n: number }>('SELECT count(*) n FROM history_batches')!.n, 0);
});

test('duplicate capture writes provenance only when the merge adds a restriction', async t => {
  const { manager, service } = await fixture(t);
  const input = { sessionId: 's', toolCallId: 'c', toolName: 'Read', input: 'x', result: raw };
  const id = (await service.capture(input)).eventId!;
  const writes: string[] = [];
  const run = manager.db.run.bind(manager.db);
  manager.db.run = (sql: string, params?: unknown[]) => { if (sql.includes('evidence_provenance')) writes.push(sql); return run(sql, params); };
  assert.equal((await service.capture(input)).eventId, id);
  assert.equal((await service.capture({ ...input, provenance: { ...partial, completeness: 'complete' } })).eventId, id);
  assert.deepEqual(writes, [], 'unchanged merges do not write under the writer lock');
  assert.equal((await service.capture({ ...input, provenance: partial })).eventId, id);
  assert.equal(writes.length, 1);
  assert.equal(provenanceFor(manager.db, id).completeness, 'partial');
  assert.equal((await service.capture({ ...input, provenance: partial })).eventId, id);
  assert.equal(writes.length, 1, 'an already-restricted source is not rewritten');
});

test('a corrupt stored provenance row never fails or promotes a harmless duplicate capture', async t => {
  const { manager, service } = await fixture(t);
  const input = { sessionId: 's', toolCallId: 'c', toolName: 'Read', input: 'x', result: raw };
  const id = (await service.capture(input)).eventId!;
  for (const bad of ['{not json', JSON.stringify({ version: 1, origin: 'bogus' })]) {
    manager.db.run('UPDATE evidence_provenance SET json=? WHERE event_id=?', [bad, id]);
    for (const provenance of [undefined, partial]) {
      const again = await service.capture({ ...input, provenance });
      assert.equal(again.archived, true, again.error ?? 'archive failed');
      assert.equal(again.eventId, id);
      assert.equal(manager.db.queryOne<{ json: string }>('SELECT json FROM evidence_provenance WHERE event_id=?', [id])!.json, bad, 'corrupt row left untouched');
    }
  }
  assert.equal(manager.db.queryAll('SELECT 1 FROM tool_events').length, 1);
});

test('index observation runs outside the SQLite writer transaction and stays fail-open', async t => {
  const { manager, service } = await fixture(t);
  const depth = () => (manager.db as unknown as { transactionDepth: number }).transactionDepth;
  const archive = manager.archive as unknown as { observeIndex: (source: { eventId: string }) => (r: { status: string }) => void };
  const seen: { phase: string; depth: number; status?: string }[] = [];
  archive.observeIndex = () => { seen.push({ phase: 'start', depth: depth() }); return ({ status }) => seen.push({ phase: 'end', depth: depth(), status }); };
  const id = (await service.capture({ sessionId: 's', toolCallId: 'one', toolName: 'Read', input: 'x', result: 'y' })).eventId!;
  assert.deepEqual(seen, [{ phase: 'start', depth: 0 }, { phase: 'end', depth: 0, status: 'ok' }]);
  seen.length = 0;
  await service.capture({ sessionId: 's', toolCallId: 'one', toolName: 'Read', input: 'x', result: 'y' });
  assert.deepEqual(seen, [], 'duplicates are not indexed or observed');
  // Rollback reports an error only after the transaction ended.
  const run = manager.db.run.bind(manager.db);
  manager.db.run = (sql: string, params?: unknown[]) => { if (sql.includes('INSERT INTO archive_search')) throw new Error('injected index failure'); return run(sql, params); };
  const failed = await service.capture({ sessionId: 's', toolCallId: 'two', toolName: 'Read', input: 'x', result: 'z' });
  assert.equal(failed.archived, false);
  assert.deepEqual(seen, [{ phase: 'start', depth: 0 }, { phase: 'end', depth: 0, status: 'error' }]);
  assert.equal(manager.db.getToolEventByCallId('core', service.scope.workspaceId, 'two'), undefined);
  manager.db.run = run;
  // Observation must never throw into capture.
  archive.observeIndex = () => { throw new Error('observer down'); };
  assert.equal((await service.capture({ sessionId: 's', toolCallId: 'three', toolName: 'Read', input: 'x', result: 'w' })).archived, true);
  archive.observeIndex = () => () => { throw new Error('observer end down'); };
  assert.equal((await service.capture({ sessionId: 's', toolCallId: 'four', toolName: 'Read', input: 'x', result: 'v' })).archived, true);
  assert.ok(manager.db.getToolEvent(id));
});
