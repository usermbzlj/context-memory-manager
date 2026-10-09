import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { ContextManager } from '../src/core/context-manager.js';
import { MemoryService } from '../src/runtime/memory.js';
import { BlobStore } from '../src/storage/blob-store.js';
import { createConfigIfAbsent, defaultConfig, loadConfig } from '../src/config.js';
import { makeManager,cleanup,cleanupAll } from './util.js';

test('a late initial config publisher preserves the winner and its exact bytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-config-race-'));
  try {
    const losing = defaultConfig(dir);
    const winner = defaultConfig(dir);
    winner.strategy = 'conservative';
    assert.equal(createConfigIfAbsent(winner), true);
    const file = path.join(dir, 'config.json');
    const bytes = fs.readFileSync(file);
    assert.equal(createConfigIfAbsent(losing), false);
    assert.deepEqual(fs.readFileSync(file), bytes);
    assert.equal(loadConfig(dir).strategy, 'conservative');
    assert.deepEqual(fs.readdirSync(dir), ['config.json']);
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('simultaneous initial config publishers have exactly one complete winner', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-config-publishers-'));
  const children: ReturnType<typeof spawn>[] = [];
  const finished: Promise<{ created: boolean; value: number }>[] = [];
  try {
    const ready = Array.from({ length: 6 }, (_, i) => new Promise<void>((resolveReady, rejectReady) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/config-publisher.js', import.meta.url)), dir, String(2000 + i)],
        { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      children.push(child);
      let stderr = '';
      let result: { created: boolean; value: number } | undefined;
      child.stderr!.on('data', bytes => { stderr += bytes.toString(); });
      const deadline = setTimeout(() => { child.kill('SIGKILL'); rejectReady(new Error('Config publisher timed out')); }, 10000);
      child.on('message', message => {
        const value = message as { ready?: boolean; created?: boolean; value?: number };
        if (value.ready) resolveReady();
        else result = { created: value.created!, value: value.value! };
      });
      finished.push(new Promise((resolve, reject) => {
        child.once('error', rejectReady);
        child.once('close', code => {
          clearTimeout(deadline);
          if (code === 0 && result) resolve(result);
          else { const error = new Error(stderr || `Config publisher exited ${code}`); rejectReady(error); reject(error); }
        });
      }));
    }));
    // Collect completion failures immediately, even while waiting at the barrier.
    const completed = Promise.allSettled(finished);
    try { await Promise.all(ready); for (const child of children) child.send!('publish'); }
    catch (error) { for (const child of children) child.kill('SIGKILL'); await completed; throw error; }
    const results = await completed;
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (errors.length) throw new AggregateError(errors.map(result => result.reason));
    const publications = results.map(result => (result as PromiseFulfilledResult<{ created: boolean; value: number }>).value);
    const winners = publications.filter(result => result.created);
    assert.equal(winners.length, 1);
    assert.equal(loadConfig(dir).integration.maxOutputChars, winners[0].value);
    assert.deepEqual(fs.readdirSync(dir), ['config.json']);
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test('three independent Node writers serialize SQLite and deduplicate blobs without losing any call',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cmm-writers-'));
  try {
    const writers=['a','b','c'].map(who=>new Promise<void>((resolve,reject)=>{
      const child=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/writer.js',import.meta.url)),dir,who,'20'],{stdio:['ignore','ignore','pipe']});
      let stderr='';let failure:Error|undefined;
      child.stderr.on('data',b=>stderr+=b.toString());child.once('error',error=>{failure=error;});
      const deadline=setTimeout(()=>{failure=new Error(`Writer ${who} timed out`);child.kill('SIGKILL');},10000);
      child.once('close',code=>{clearTimeout(deadline);if(failure)reject(failure);else if(code===0)resolve();else reject(new Error(stderr || `Writer ${who} exited ${code}`));});
    }));
    // Promise.all rejects before the other writers close. On Windows that makes
    // failure cleanup race their still-open SQLite handles.
    const results=await Promise.allSettled(writers);
    const errors=results.filter((result):result is PromiseRejectedResult=>result.status==='rejected').map(result=>result.reason);
    if(errors.length)throw new AggregateError(errors,'Concurrent writers failed');
    const manager=ContextManager.open(dir,{logging:{dir:null}});try {
      const service=new MemoryService(manager,{agent:'concurrent',workspaceId:dir});assert.equal(service.status().archive?.events,60);assert.equal((await service.verify()).checked,60);assert.equal((await service.verify()).failed,0);
      const refs=manager.db.queryAll<{ref:string}>('SELECT DISTINCT result_ref AS ref FROM tool_events');assert.equal(refs.length,1);
    }finally{manager.close();}
  }finally{fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
test('future database schema is refused before any table or user_version is rewritten',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cmm-future-'));let raw:DatabaseSync|undefined;
  try {
    const file=path.join(dir,'cmm.db');raw=new DatabaseSync(file);raw.exec('CREATE TABLE future_data(value TEXT); INSERT INTO future_data VALUES (\'do not alter\'); PRAGMA user_version=999;');raw.close();raw=undefined;
    assert.throws(()=>ContextManager.open(dir),/newer/);raw=new DatabaseSync(file);assert.equal((raw.prepare('PRAGMA user_version').get() as any).user_version,999);assert.equal((raw.prepare('SELECT * FROM future_data').get() as any).value,'do not alter');assert.equal(raw.prepare("SELECT name FROM sqlite_master WHERE name='tool_events'").get(),undefined);
  }finally{await cleanupAll(()=>raw?.close(),()=>{fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});}
});
test('nested transactions roll back only their savepoint and async callbacks cannot commit',async t=>{
  const {manager,dir}=await makeManager();t.after(()=>cleanup(dir,manager));
  manager.db.transaction(()=>{
    manager.db.bumpStat('outer',1);
    assert.throws(()=>manager.db.transaction(()=>{manager.db.bumpStat('inner',1);throw new Error('rollback inner');}));
    manager.db.bumpStat('outer',1);
  });assert.equal(manager.db.getStats().outer,2);assert.equal(manager.db.getStats().inner,undefined);
  assert.throws(()=>manager.db.transaction(async()=>{manager.db.bumpStat('async',1);}),/synchronous/);assert.equal(manager.db.getStats().async,undefined);
});
test('GC commits event deletion before touching blobs and never deletes a shared live blob',async t=>{
  const {manager,dir}=await makeManager({storage:{maxSizeBytes:1}});t.after(()=>cleanup(dir,manager));const service=new MemoryService(manager,{agent:'gc',workspaceId:dir});
  const raw='shared evidence\n'.repeat(2000);const save=async(s:string)=>(await service.capture({sessionId:s,toolCallId:'c',toolName:'Read',input:'x',result:raw})).eventId!;
  const victim=await save('old'),live=await save('live');manager.db.updateToolEvent(victim,{state:'evicted'});
  const original=manager.archive.deleteUnreferencedBlob.bind(manager.archive);let called=false;
  manager.archive.deleteUnreferencedBlob=(ref,id)=>{called=true;assert.equal(manager.db.getToolEvent(victim),undefined);return original(ref,id);};
  assert.equal((await manager.gc()).deletedEvents,1);assert.equal(called,true);assert.equal((await service.recall(live,{limit:20})).text,raw.slice(0,20));await assert.rejects(()=>manager.archive.fetchOriginal(victim),/explicitly deleted/);
});
test('symlinked archive paths cannot escape the storage root',async t=>{
  if(process.platform==='win32'){t.skip('Creating a symlink may require Windows developer mode; path traversal is covered on every platform');return;}
  const {dir,manager}=await makeManager();t.after(()=>cleanup(dir,manager));const blobs=new BlobStore(path.join(dir,'symlink-store'),0);const ref=blobs.put('protected');const file=blobs.blobFilePath(ref);
  fs.unlinkSync(file);const outside=path.join(dir,'outside');fs.writeFileSync(outside,'protected');fs.symlinkSync(outside,file);assert.throws(()=>blobs.get(ref),/symlink|escapes/);assert.equal(fs.readFileSync(outside,'utf8'),'protected');
});
