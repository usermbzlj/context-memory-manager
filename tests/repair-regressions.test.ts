import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MemoryService } from '../src/runtime/memory.js';
import { normalizeWorkspaceId } from '../src/storage/archive.js';
import { truncateText } from '../src/util/text.js';
import { inferProvenance } from '../src/evidence/provenance.js';
import { makeManager, cleanup } from './util.js';

const raw = 'evidence line\n'.repeat(9000);
async function fixture(t: TestContext) {
  const { manager, dir } = await makeManager();
  t.after(() => cleanup(dir, manager));
  return { manager, dir, service: new MemoryService(manager, { agent: 'repair', workspaceId: dir }) };
}

test('input recall cannot restore a large result or alter protection and views', async t => {
  const { manager, service } = await fixture(t);
  const id = (await service.capture({ sessionId: 's', toolCallId: 'c', toolName: 'Read', input: 'x', result: raw })).eventId!;
  manager.db.updateToolEvent(id, { state: 'capsule', protected_until_turn: 0 });
  const projection = await service.project(id, raw, 'history', 's');
  const before = manager.db.getToolEvent(id);
  await assert.rejects(() => service.recall(id, { field: 'input', limit: 1, restore: true, sessionId: 'target' }), /result page/);
  assert.deepEqual(manager.db.getToolEvent(id), before);
  assert.equal(manager.db.queryOne('SELECT * FROM event_views WHERE event_id=?', [id]), undefined);
  assert.equal((await service.recall(id, { field: 'input', limit: 1 })).text, 'x');
  const history = await service.transform('s', [{ eventId: id, output: projection.text }], { usedTokens: 1000, contextWindow: 200000 });
  assert.equal(history.projections[0].text, projection.text);
});

test('Unicode projection survives cache reads, reopen and pin restoration byte-for-byte', async t => {
  const { manager, dir } = await makeManager();
  let current = manager;
  t.after(() => cleanup(dir, current));
  let service = new MemoryService(current, { agent: 'repair', workspaceId: dir });
  const id = (await service.capture({ sessionId: 's', toolCallId: 'c', toolName: 'Read', input: 'a'.repeat(114) + '🚀', result: raw })).eventId!;
  current.db.updateToolEvent(id, { state: 'capsule', protected_until_turn: 0 });
  const projection = await service.project(id, raw, 'history', 's');
  assert.equal(Buffer.from(projection.text).toString(), projection.text);
  assert.equal((await service.project(id, projection.text, 'history', 's')).cacheHit, true);
  current.close();
  const { ContextManager } = await import('../src/core/context-manager.js');
  current = ContextManager.open(dir, { logging: { dir: null } });
  service = new MemoryService(current, { agent: 'repair', workspaceId: dir });
  assert.equal((await service.project(id, projection.text, 'history', 's')).text, projection.text);
  assert.equal((await service.verify()).failed, 0);
  await service.pin(id, true);
  assert.equal((await service.project(id, projection.text, 'history', 's')).text, raw);
  for (const bound of [120, 160, 200, 280, 300, 8000]) {
    const value = 'a'.repeat(bound - 1) + '🚀tail';
    assert.equal(truncateText(value, bound), 'a'.repeat(bound - 1));
    assert.equal(truncateText(value, bound + 1), 'a'.repeat(bound - 1) + '🚀');
  }
});

test('verify checks source and visible hashes for every projection representation', async t => {
  for (const representation of ['text', 'stdout', 'mcp-text'] as const) await t.test(representation, async child => {
    const { manager, service } = await fixture(child);
    manager.config.integration.ingressCompression = true;
    const result = representation === 'text' ? raw : representation === 'stdout' ? JSON.stringify({ stdout: raw }) :
      JSON.stringify({ content: [{ type: 'text', text: raw }] });
    const id = (await service.capture({ sessionId: 's', toolCallId: 'c', toolName: 'Read', input: 'x', result })).eventId!;
    assert.equal((await service.project(id, raw, 'ingress', 's', representation)).replaced, true);
    assert.equal((await service.verify()).failed, 0);
    const receipt = manager.db.queryOne<{source_sha: string}>('SELECT source_sha FROM projection_cache WHERE event_id=?', [id])!;
    manager.db.run('UPDATE projection_cache SET source_sha=? WHERE event_id=?', ['0'.repeat(64), id]);
    assert.equal((await service.verify()).projectionFailed, 1);
    await assert.rejects(() => service.project(id, raw, 'ingress', 's', representation), /integrity mismatch/);
    manager.db.run('UPDATE projection_cache SET source_sha=?, visible_sha=? WHERE event_id=?', [receipt.source_sha, '0'.repeat(64), id]);
    assert.equal((await service.verify()).projectionFailed, 1);
  });
});

test('verify rejects unsupported receipt identities and unauthorized session views', async t => {
  const { manager, service, dir } = await fixture(t);
  const id = (await service.capture({ sessionId: 's', toolCallId: 'c', toolName: 'Read', input: 'x', result: raw })).eventId!;
  manager.db.updateToolEvent(id, { state: 'capsule' });
  await service.project(id, raw, 'history', 's');
  const original = manager.db.queryOne<{session_id: string}>('SELECT session_id FROM projection_cache WHERE event_id=?', [id])!;
  for (const [column, value] of [['representation', 'invalid'], ['mode', 'invalid']] as const) {
    manager.db.run(`UPDATE projection_cache SET ${column}=? WHERE event_id=?`, [value, id]);
    assert.equal((await service.verify()).projectionFailed, 1);
    manager.db.run(`UPDATE projection_cache SET ${column}=? WHERE event_id=?`, [column === 'mode' ? 'history' : 'text', id]);
  }
  manager.db.ensureSession('foreign', normalizeWorkspaceId(dir), 'foreign');
  manager.db.run('UPDATE projection_cache SET session_id=? WHERE event_id=?', ['foreign', id]);
  assert.equal((await service.verify()).projectionFailed, 1);
  manager.db.ensureSession('repair', normalizeWorkspaceId(dir), 'no-view');
  manager.db.run('UPDATE projection_cache SET session_id=? WHERE event_id=?', ['no-view', id]);
  assert.equal((await service.verify()).projectionFailed, 1);
  manager.db.run('UPDATE projection_cache SET session_id=? WHERE event_id=?', [original.session_id, id]);
  assert.equal((await service.verify()).failed, 0);
});

test('explicit partial provenance is retained when RTK command detection applies', () => {
  const provenance = inferProvenance({ input: 'rtk test', result: 'filtered lines', provenance: {
    version: 1, origin: 'tool-observation', captureStage: 'host-result', completeness: 'partial', notes: ['metadata.truncated'],
  } });
  assert.equal(provenance.origin, 'upstream-filtered');
  assert.equal(provenance.completeness, 'partial');
});

test('reindex does not republish evidence retired while its original read was pending', async t => {
  const { manager, service } = await fixture(t);
  manager.config.storage.maxSizeBytes = 1;
  const id = (await service.capture({ sessionId: 's', toolCallId: 'retiring', toolName: 'Read', input: 'x', result: raw })).eventId!;
  manager.db.updateToolEvent(id, { state: 'evicted', protected_until_turn: 0 });
  const fetch = manager.archive.fetchOriginal.bind(manager.archive);
  manager.archive.fetchOriginal = async eventId => {
    const original = await fetch(eventId);
    assert.equal((await manager.gc()).deletedEvents, 1);
    return original;
  };
  const verification = await service.verify(true);
  assert.equal(verification.failed, 0, 'retirement is not archive corruption');
  assert.equal(verification.checked, 0, 'a retired event is skipped');
  assert.equal(manager.db.getToolEvent(id), undefined);
  assert.ok(manager.db.queryOne('SELECT event_id FROM archive_tombstones WHERE event_id=?', [id]));
  for (const table of ['evidence_chunks', 'evidence_index', 'archive_search']) {
    assert.equal(manager.db.queryOne(`SELECT event_id FROM ${table} WHERE event_id=?`, [id]), undefined,
      `${table} must remain retired`);
  }
});

test('pin rejects an event retired while its original read was pending without creating an orphan pin', async t => {
  const { manager, service } = await fixture(t);
  manager.config.storage.maxSizeBytes = 1;
  const id = (await service.capture({ sessionId: 's', toolCallId: 'retiring', toolName: 'Read', input: 'x', result: raw })).eventId!;
  manager.db.updateToolEvent(id, { state: 'evicted', protected_until_turn: 0 });
  const fetch = manager.archive.fetchOriginal.bind(manager.archive);
  manager.archive.fetchOriginal = async eventId => {
    const original = await fetch(eventId);
    assert.equal((await manager.gc()).deletedEvents, 1);
    return original;
  };
  await assert.rejects(() => service.pin(id, true), /not available.*explicitly deleted/i);
  assert.equal(manager.db.getToolEvent(id), undefined);
  assert.deepEqual(manager.db.listPinsForTarget('event', id), []);
});

test('legacy Windows workspace and host session identities remain readable and idempotent', async t => {
  const { manager, dir } = await makeManager();
  t.after(() => cleanup(dir, manager));
  const workspace = 'c:\\CMM-legacy-nonexistent\\Project';
  const legacyWorkspace = 'C' + workspace.slice(1);
  const agent = 'legacy';
  const host = 's';
  const legacySession = 'cmm:' + createHash('sha256').update(JSON.stringify([agent, legacyWorkspace, host])).digest('hex');
  manager.db.ensureAgent(agent);
  manager.db.ensureWorkspace(agent, legacyWorkspace, legacyWorkspace);
  manager.db.ensureSession(agent, legacyWorkspace, legacySession);
  const service = new MemoryService(manager, { agent, workspaceId: workspace });
  assert.equal(service.scope.workspaceId, legacyWorkspace);
  assert.equal(service.hostSessionId(host), legacySession);
  const saved = await service.capture({ sessionId: host, toolCallId: 'c', toolName: 'Read', input: 'x', result: 'legacy bytes' });
  assert.equal(saved.archived, true);
  assert.equal(manager.db.getToolEvent(saved.eventId!)?.session_id, legacySession);
  assert.equal(manager.db.getToolEvent(saved.eventId!)?.workspace_id, legacyWorkspace);
  assert.equal(service.search().results[0].eventId, saved.eventId);
  assert.equal(service.lookup(host, 'c', 'Read')?.eventId, saved.eventId);
  assert.equal((await manager.recall('c', agent, workspace)).result, 'legacy bytes');
  assert.equal((await service.capture({ sessionId: host, toolCallId: 'c', toolName: 'Read', input: 'x', result: 'legacy bytes' })).eventId, saved.eventId);
  manager.db.ensureWorkspace(agent, workspace, workspace);
  assert.throws(() => new MemoryService(manager, { agent, workspaceId: workspace }), /Conflicting legacy workspace/);
  assert.equal(manager.db.getToolEvent(saved.eventId!)?.workspace_id, legacyWorkspace);
});

test('legacy missing-project parent spelling is resolved without rewriting its identity', async t => {
  if (process.platform !== 'win32') { t.skip('Windows filesystem spelling compatibility'); return; }
  const { manager, dir } = await makeManager();
  t.after(() => cleanup(dir, manager));
  const parent = path.join(dir, 'CaseParent');
  fs.mkdirSync(parent);
  const requested = path.join(parent, 'MissingProject');
  const legacy = path.join(parent.toLowerCase(), 'MissingProject');
  manager.db.ensureAgent('legacy');
  manager.db.ensureWorkspace('legacy', legacy, legacy);
  const service = new MemoryService(manager, { agent: 'legacy', workspaceId: requested });
  assert.equal(service.scope.workspaceId, legacy);
  const saved = await service.capture({ sessionId: 's', toolCallId: 'c', toolName: 'Read', input: 'x', result: 'old scope' });
  assert.equal(saved.archived, true);
  assert.equal(manager.db.getToolEvent(saved.eventId!)?.workspace_id, legacy);
  assert.equal(service.search().results[0].eventId, saved.eventId);
});
