import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { normalizeWorkspaceId, resolveWorkspaceId } from '../src/storage/archive.js';
import { Database } from '../src/storage/sqlite.js';
import { ContextManager } from '../src/core/context-manager.js';
import { MemoryService, sessionKey } from '../src/runtime/memory.js';
import { removeDir } from './remove-dir.js';

function temporaryRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-workspace-regression-'));
}

function removeTemporaryRoot(dir: string): void {
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(dir));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  assert.ok(path.basename(dir).startsWith('cmm-workspace-regression-'));
  removeDir(dir);
}

test('Windows drive and UNC identities are lexical, idempotent and preserve component case', t => {
  // Exercise UNC spelling without making a network filesystem request.
  t.mock.method(fs.realpathSync, 'native', () => { throw new Error('Unavailable test path'); });
  const forms = [
    ['Z:/Cmm Mixed/Project/../Leaf/', 'z:\\Cmm Mixed\\Leaf'],
    ['z:\\Cmm Mixed\\Leaf', 'z:\\Cmm Mixed\\Leaf'],
    ['Z:\\', 'z:\\'],
    ['\\\\CmmHost\\CmmShare\\Folder\\..\\Work\\', '\\\\CmmHost\\CmmShare\\Work'],
    ['\\\\CmmHost\\CmmShare', '\\\\CmmHost\\CmmShare\\'],
  ];
  for (const [input, expected] of forms) {
    const normalized = normalizeWorkspaceId(input);
    assert.equal(normalized, expected);
    assert.equal(normalizeWorkspaceId(normalized), normalized);
  }
  assert.notEqual(normalizeWorkspaceId('Z:\\Project'), normalizeWorkspaceId('Z:\\project'));
  for (const opaque of ['ws', 'CaseSensitiveId', 'project:1', '550e8400-e29b-41d4-a716-446655440000'])
    assert.equal(normalizeWorkspaceId(opaque), opaque);
});

test('relative, absolute and existing workspace spellings share a stable identity', () => {
  const dir = temporaryRoot();
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    fs.mkdirSync('MixedCaseParent');
    const relative = './MixedCaseParent/ProjectCase/';
    const absolute = path.resolve(relative);
    const before = normalizeWorkspaceId(relative);
    assert.equal(normalizeWorkspaceId(absolute), before);
    assert.equal(normalizeWorkspaceId(before), before);
    if (process.platform === 'win32') {
      assert.match(before, /^[a-z]:/);
      assert.equal(normalizeWorkspaceId(absolute.replace(/^([a-z]):/i, (_, drive: string) => `${drive.toUpperCase()}:`)), before);
      assert.equal(normalizeWorkspaceId('./mixedcaseparent/ProjectCase'), before,
        'An available parent supplies its real spelling before the leaf exists');
    }
    fs.mkdirSync(absolute);
    assert.equal(normalizeWorkspaceId(relative), before);
    assert.equal(normalizeWorkspaceId(absolute), before);
    assert.equal(normalizeWorkspaceId(before), before);
    assert.notEqual(normalizeWorkspaceId('./MixedCaseParent/OtherProject'), before);
  } finally {
    process.chdir(previousCwd);
    removeTemporaryRoot(dir);
  }
});

test('capture lookup search recall and pin work before and after workspace creation', async () => {
  const dir = temporaryRoot();
  const previousCwd = process.cwd();
  let manager: ContextManager | undefined;
  try {
    process.chdir(dir);
    manager = ContextManager.open(path.join(dir, 'storage'), { logging: { dir: null } });
    const workspace = './Missing/WorkspaceCase';
    const service = new MemoryService(manager, { agent: 'workspace-regression', workspaceId: workspace });
    const result = 'WORKSPACE_IDENTITY_EVIDENCE\r\nexact captured content';
    const captured = await service.capture({ sessionId: 'host', toolCallId: 'call', toolName: 'Read', input: 'log.txt', result });
    assert.equal(captured.archived, true, captured.error ?? 'capture failed');
    const id = captured.eventId!;
    assert.equal(service.lookup('host', 'call', 'Read')?.eventId, id);
    assert.equal(service.search('WORKSPACE_IDENTITY_EVIDENCE').results[0]?.eventId, id);
    assert.equal((await service.recall(id)).text, result);
    assert.equal((await manager.recall('call', service.scope.agent, workspace)).result, result);
    await manager.pin({ toolCallId: 'call', agent: service.scope.agent, workspaceId: workspace });
    assert.equal(service.event(id).pinned, 1);
    await manager.unpin({ toolCallId: 'call', agent: service.scope.agent, workspaceId: path.resolve(workspace) });
    assert.equal(service.event(id).pinned, 0);
    await service.pin(id, true);
    assert.equal(service.event(id).pinned, 1);
    await service.pin(id, false);

    fs.mkdirSync(path.resolve(workspace), { recursive: true });
    const reopenedScope = new MemoryService(manager, { agent: service.scope.agent, workspaceId: path.resolve(workspace) });
    assert.equal(reopenedScope.scope.workspaceId, service.scope.workspaceId);
    assert.equal(sessionKey(reopenedScope.scope, 'host'), sessionKey(service.scope, 'host'));
    const duplicate = await reopenedScope.capture({ sessionId: 'host', toolCallId: 'call', toolName: 'Read', input: 'log.txt', result });
    assert.equal(duplicate.eventId, id);
    assert.equal(manager.db.queryOne<{ n: number }>('SELECT count(*) AS n FROM tool_events')?.n, 1);
    assert.equal(reopenedScope.lookup('host', 'call', 'Read')?.eventId, id);

    const other = new MemoryService(manager, { agent: service.scope.agent, workspaceId: './Other/WorkspaceCase' });
    const separate = await other.capture({ sessionId: 'host', toolCallId: 'call', toolName: 'Read', input: 'log.txt', result: 'other evidence' });
    assert.equal(separate.archived, true, separate.error ?? 'capture failed');
    assert.notEqual(separate.eventId, id);
    assert.notEqual(sessionKey(other.scope, 'host'), sessionKey(service.scope, 'host'));
    assert.equal(other.search('WORKSPACE_IDENTITY_EVIDENCE').results.length, 0);
    assert.throws(() => other.event(id), /scope/);
    assert.equal((await service.verify()).failed, 0);
  } finally {
    manager?.close();
    process.chdir(previousCwd);
    removeTemporaryRoot(dir);
  }
});

test('UNC legacy scope resolution folds only volume names and observes new conflicts without network access', t => {
  const dir = temporaryRoot();
  const db = Database.open(path.join(dir, 'scope.db'));
  t.after(() => { db.close(); removeTemporaryRoot(dir); });
  t.mock.method(fs.realpathSync, 'native', () => { throw new Error('Unavailable test path'); });
  const legacy = '\\\\CMMHOST\\CmmShare\\CaseProject\\';
  const requested = '\\\\cmmhost\\cmmshare\\CaseProject';
  db.ensureAgent('resolver');
  db.ensureWorkspace('resolver', legacy, legacy);
  db.ensureWorkspace('resolver', '\\\\OtherHost\\CmmShare\\CaseProject', 'unrelated server');
  db.ensureWorkspace('resolver', '\\\\CmmHost\\OtherShare\\CaseProject', 'unrelated share');
  assert.equal(resolveWorkspaceId(db, 'resolver', requested), legacy);
  const differentComponent = '\\\\cmmhost\\cmmshare\\caseproject';
  assert.equal(resolveWorkspaceId(db, 'resolver', differentComponent), differentComponent);
  db.ensureWorkspace('resolver', requested, requested);
  assert.throws(() => resolveWorkspaceId(db, 'resolver', requested), /Conflicting legacy workspace/);
  assert.equal(db.queryAll<{id: string}>('SELECT id FROM workspaces WHERE id=?', [legacy])[0]?.id, legacy);
});

test('lexical drive candidates stay separate across volumes and avoid redundant canonical path probes', t => {
  const dir = temporaryRoot();
  const db = Database.open(path.join(dir, 'scope.db'));
  t.after(() => { db.close(); removeTemporaryRoot(dir); });
  const probes: string[] = [];
  t.mock.method(fs.realpathSync, 'native', (value: fs.PathLike) => {
    probes.push(String(value));
    throw new Error('Unavailable test path');
  });
  const requested = 'd:\\Known\\Project';
  db.ensureAgent('resolver');
  for (const id of [requested, 'E:\\Known\\Project', 'd:\\known\\Project', '\\\\Host\\Share\\Known\\Project'])
    db.ensureWorkspace('resolver', id, id);
  assert.equal(resolveWorkspaceId(db, 'resolver', requested), requested);
  assert.equal(probes.filter(value => value === requested).length, process.platform === 'win32' ? 1 : 0,
    'The already-normalized canonical candidate does not repeat its full-path realpath probe');
  db.ensureWorkspace('resolver', 'D:\\Known\\Project\\', 'legacy equivalent');
  assert.throws(() => resolveWorkspaceId(db, 'resolver', requested), /Conflicting legacy workspace/);
});

test('cross-volume legacy junction aliases still resolve and all conflicting aliases are checked', t => {
  if (process.platform !== 'win32') { t.skip('Windows native realpath junction mapping'); return; }
  const dir = temporaryRoot();
  const db = Database.open(path.join(dir, 'scope.db'));
  t.after(() => { db.close(); removeTemporaryRoot(dir); });
  const requested = 'D:\\Junction\\Project';
  const alias = 'E:\\AnotherJunction\\Project';
  const physical = 'C:\\Canonical\\Project';
  const driverKey = (value: string) => value.replace(/^([A-Z]):/, (_, drive: string) => `${drive.toLowerCase()}:`);
  const aliases = new Set([requested, alias, physical].map(driverKey));
  t.mock.method(fs.realpathSync, 'native', (value: fs.PathLike) => {
    if (aliases.has(driverKey(path.win32.normalize(String(value))))) return physical;
    throw new Error('Unavailable test path');
  });
  db.ensureAgent('resolver');
  db.ensureWorkspace('resolver', alias, alias);
  assert.equal(resolveWorkspaceId(db, 'resolver', requested), alias);
  db.ensureWorkspace('resolver', requested, requested);
  assert.throws(() => resolveWorkspaceId(db, 'resolver', requested), /Conflicting legacy workspace/,
    'A third-volume alias must not be dropped by a requested/canonical volume prefilter');
});
