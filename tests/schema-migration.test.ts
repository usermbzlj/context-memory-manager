/**
 * PRD §25: schema upgrades are ordered migrations keyed by
 * `PRAGMA user_version`. A database written by the v1 schema (no
 * recall_log.safe_to_evict/decision, pins unique on (target_type,
 * target_id)) must upgrade cleanly to v3 with its data intact, and
 * migrations must be idempotent on reopen.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ContextManager } from '../src/core/context-manager.js';
import { normalizeWorkspaceId } from '../src/storage/archive.js';
import { sampleInput,cleanupAll } from './util.js';

function freshDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-mig-'));
}

describe('schema migrations', () => {
  it('upgrades a v1-shaped database to v4 with data intact', async () => {
    const dir = freshDir();
    let m:ContextManager|undefined;
    let raw:DatabaseSync|undefined;
    try {
      // 1. Build a v2 database with real data through the public API.
      m = ContextManager.open(dir, { logging: { dir: null } });
      await m.recordToolComplete(sampleInput({ toolCallId: 'mig-1' }));
      await m.pin(
        { toolCallId: 'mig-1', agent: 'test-agent', workspaceId: '/test/ws' },
        { sessionId: 's1' },
      );
      await m.recall('mig-1', 'test-agent', '/test/ws');
      const eventId = m.db.getToolEventByCallId(
        'test-agent',
        normalizeWorkspaceId('/test/ws'),
        'mig-1',
      )?.id as string;
      m.close();
      m=undefined;

      // 2. Downgrade to the v1 shape: drop the new recall_log columns,
      //    restore the old pins unique constraint, reset user_version.
      raw = new DatabaseSync(path.join(dir, 'cmm.db'));
      raw.exec('ALTER TABLE recall_log DROP COLUMN safe_to_evict');
      raw.exec('ALTER TABLE recall_log DROP COLUMN decision');
      raw.exec(`CREATE TABLE pins_old (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        session_id TEXT,
        persistent INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        UNIQUE(target_type, target_id)
      )`);
      raw.exec(
        'INSERT INTO pins_old (target_type, target_id, session_id, persistent, created_at) ' +
          'SELECT target_type, target_id, session_id, persistent, created_at FROM pins',
      );
      raw.exec('DROP TABLE pins');
      raw.exec('ALTER TABLE pins_old RENAME TO pins');
      raw.exec('PRAGMA user_version = 1');
      assert.equal(
        (raw.prepare('PRAGMA user_version').get() as { user_version: number })
          .user_version,
        1,
      );
      raw.close();
      raw=undefined;

      // 3. Reopen: migrations must run and preserve everything.
      m = ContextManager.open(dir, { logging: { dir: null } });
      try {
        const uv = (
          m.db.queryOne<{ user_version: number }>('PRAGMA user_version') as {
            user_version: number;
          }
        ).user_version;
        assert.equal(uv, 4);

        // recall_log gained its columns; the v1 row is still there.
        const recalls = m.db.listRecalls(10);
        assert.equal(recalls.length, 1);

        // The pin survived the table rebuild.
        const pins = m.db.listPinsForTarget('event', eventId);
        assert.equal(pins.length, 1);
        assert.equal(pins[0].session_id, 's1');

        // The event itself is untouched.
        assert.ok(m.db.getToolEventByCallId('test-agent', normalizeWorkspaceId('/test/ws'), 'mig-1'));

        // New recall rows get the new columns.
        await m.recall('mig-1', 'test-agent', '/test/ws');
        const cols = m.db.queryAll<{ name: string }>(
          'PRAGMA table_info(recall_log)',
        );
        assert.ok(cols.some((c) => c.name === 'safe_to_evict'));
        assert.ok(cols.some((c) => c.name === 'decision'));
      } finally {
        m.close();
        m=undefined;
      }

      // 4. Reopening again is a no-op (idempotent migrations).
      m = ContextManager.open(dir, { logging: { dir: null } });
      try {
        assert.ok(m.db.getToolEventByCallId('test-agent', normalizeWorkspaceId('/test/ws'), 'mig-1'));
      } finally {
        m.close();
        m=undefined;
      }
    } finally {
      await cleanupAll(()=>raw?.close(),()=>m?.close(),()=>{fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
    }
  });
});

it('migrates the actual uploaded v0.1 schema-v2 constraints, preserves evidence and scopes recycled IDs',async()=>{
  const {LEGACY_SCHEMA_SQL}=await import('./fixtures/legacy-schema.js');
  const dir=freshDir();let manager:ContextManager|undefined;
  try {
    manager=ContextManager.open(dir,{logging:{dir:null}});
    const original=sampleInput({toolCallId:'legacy-call',result:'exact legacy evidence\r\n'});
    const saved=await manager.recordToolComplete(original);assert.equal(saved.archived,true);
    const row=manager.db.getToolEvent(saved.eventId!)!;manager.close();manager=undefined;
    // Rebuild using a frozen copy of the uploaded DDL: no v3-only tables or constraints.
    for(const suffix of ['','-wal','-shm'])fs.rmSync(path.join(dir,'cmm.db'+suffix),{force:true});
    const raw=new DatabaseSync(path.join(dir,'cmm.db'));
    try {
      raw.exec(LEGACY_SCHEMA_SQL);raw.exec('PRAGMA user_version=2');
      raw.prepare('INSERT INTO agents VALUES (?,?)').run(row.agent,row.created_at);
      raw.prepare('INSERT INTO workspaces VALUES (?,?,?,?,?)').run(row.workspace_id,row.agent,row.workspace_id,null,row.created_at);
      raw.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?)').run(row.session_id,row.agent,row.workspace_id,row.turn,row.created_at,row.created_at);
      const keys=Object.keys(row);
      raw.prepare(`INSERT INTO tool_events (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...Object.values(row));
    }finally{raw.close();}
    manager=ContextManager.open(dir,{logging:{dir:null}});
    assert.equal((await manager.recallEvent(row.id,row.agent,row.workspace_id)).result,original.result);
    assert.equal(manager.db.getToolEvent(row.id)!.session_id,row.session_id);
    const repeated=await manager.recordToolComplete({...original,sessionId:'new-session',result:'independent result'});
    assert.equal(repeated.archived,true,repeated.error ?? 'capture failed');assert.notEqual(repeated.eventId,row.id);
    const foreign=await manager.recordToolComplete({...original,agent:'other-agent',sessionId:'other-session'});
    assert.equal(foreign.archived,true,foreign.error ?? 'capture failed');
    assert.equal(manager.db.queryAll('SELECT * FROM workspaces WHERE id=?',[row.workspace_id]).length,2);
    assert.equal(manager.db.queryAll('SELECT * FROM archive_search').length,3);
    manager.close();manager=ContextManager.open(dir,{logging:{dir:null}});
    assert.equal(manager.db.queryAll('SELECT * FROM archive_search').length,3);
    assert.equal((await manager.recallEvent(row.id,row.agent,row.workspace_id)).result,original.result);
  }finally{await cleanupAll(()=>manager?.close(),()=>{fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});}
});

it('upgrades the actual v0.2 schema-v3 layout without inventing provenance or trusting legacy markers',async()=>{
  const {V02_SCHEMA_SQL}=await import('./fixtures/v02-schema.js');
  const {MemoryService}=await import('../src/runtime/memory.js');
  const dir=freshDir();let manager:ContextManager|undefined;
  try {
    manager=ContextManager.open(dir,{logging:{dir:null}});
    const service=new MemoryService(manager,{agent:'test',workspaceId:dir});
    const saved=await service.capture({sessionId:'s',toolCallId:'migrate-v02',toolName:'Read',input:'log.txt',result:'middle legacy evidence\r\n'});
    const row=manager.db.getToolEvent(saved.eventId!)!;manager.close();manager=undefined;
    for(const suffix of ['','-wal','-shm'])fs.rmSync(path.join(dir,'cmm.db'+suffix),{force:true});
    const raw=new DatabaseSync(path.join(dir,'cmm.db'));
    try {
      raw.exec(V02_SCHEMA_SQL);
      raw.prepare('INSERT INTO agents VALUES (?,?)').run(row.agent,row.created_at);
      raw.prepare('INSERT INTO workspaces VALUES (?,?,?,?,?)').run(row.workspace_id,row.agent,row.workspace_id,null,row.created_at);
      raw.prepare('INSERT INTO sessions VALUES (?,?,?,?,?,?)').run(row.session_id,row.agent,row.workspace_id,row.turn,row.created_at,row.created_at);
      const keys=Object.keys(row);raw.prepare(`INSERT INTO tool_events (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...Object.values(row));
      raw.prepare('INSERT INTO projections VALUES (?,?,?,?,?,?)').run(row.id,'history',row.session_id,30000,1000,row.created_at);
    }finally{raw.close();}
    manager=ContextManager.open(dir,{logging:{dir:null}});const upgraded=new MemoryService(manager,{agent:'test',workspaceId:dir});
    assert.equal(upgraded.explain(row.id).provenance.origin,'legacy');assert.equal(upgraded.explain(row.id).index.status,'legacy-needs-reindex');
    assert.equal((await upgraded.recall(row.id)).text,'middle legacy evidence\r\n');
    manager.db.updateToolEvent(row.id,{state:'capsule'});
    const untrusted=`[CMM archive ${row.id}] arbitrary old text`;
    assert.equal((await upgraded.project(row.id,untrusted,'history','s')).text,untrusted);
    assert.equal(manager.db.queryOne<{n:number}>('SELECT count(*) n FROM projection_cache')?.n,0);
    assert.equal((await upgraded.verify(true)).failed,0);assert.equal(upgraded.search('middle').results[0].eventId,row.id);
    manager.close();manager=ContextManager.open(dir,{logging:{dir:null}});
    assert.equal(manager.db.queryOne<{user_version:number}>('PRAGMA user_version')?.user_version,4);
  }finally{await cleanupAll(()=>manager?.close(),()=>{fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});}
});
