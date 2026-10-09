import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ContextManager } from '../src/core/context-manager.js';
import { MemoryService, type VerificationProgress } from '../src/runtime/memory.js';
import { completeWithFailover } from '../src/providers/failover.js';
import { createLogger } from '../src/logging.js';
import { configRevision } from '../src/config.js';
import { rowToToolEvent } from '../src/types.js';
import { createRuntimeObserver, enableRuntime, observeOperation, readRuntime, RUNTIME_LIMITS } from '../src/observability/runtime.js';

const scope={agent:'codex',workspaceId:'synthetic-observation-workspace'};
// These tests read the channel right after each call, so they opt out of the production lease cache and publish coalescing.
const immediate={publishMs:0,leaseCacheMs:0};
function temporary() { return fs.mkdtempSync(path.join(os.tmpdir(),'cmm-observability-')); }
function remove(root: string) { fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}); }
function slot(root: string) { return fs.readdirSync(path.join(root,'runtime')).filter(name=>name.startsWith('slot-')).map(name=>path.join(root,'runtime',name)); }
async function child(source: string, root: string): Promise<void> {
  const peer=spawn(process.execPath,['--input-type=module','-e',source],{env:{...process.env,CMM_OBS_STORAGE:root},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let error='';peer.stderr.on('data',chunk=>{error+=chunk.toString();});
  await new Promise<void>((resolve,reject)=>{peer.on('error',reject);peer.on('close',code=>code===0?resolve():reject(new Error(error)));});
}

test('runtime stays disabled without a dashboard lease; unavailable channels never break archive or provider calls',async () => {
  const root=temporary();const manager=ContextManager.open(root);const service=new MemoryService(manager,scope);
  try {
    const result=await service.capture({sessionId:'s',toolName:'Read',input:'private input',result:'private result'});
    assert.equal(result.archived,true);assert.equal(fs.existsSync(path.join(root,'runtime')),false);
    assert.equal(readRuntime(root).enabled,false);
    fs.writeFileSync(path.join(root,'runtime'),'channel deliberately unavailable');
    const lease=enableRuntime(root);
    const again=await service.capture({sessionId:'s',toolName:'Read',input:'private input',result:'private result'});
    assert.equal(again.archived,true);
    const records: unknown[]=[];
    const response=await completeWithFailover([{name:'local',async complete(){return {text:'unchanged',tokensIn:1,tokensOut:2,model:'fixture'};}}],{user:'SECRET prompt'},
      {purpose:'capsule',logger:createLogger(),recordCall:r=>records.push(r),observe:()=>{throw new Error('observer failure');}});
    assert.equal(response.text,'unchanged');assert.equal(records.length,1);lease.stop();
    const original=await service.recall(again.eventId!);assert.equal(original.text,'private result');
  } finally {manager.close();remove(root);}
});

test('operation snapshots show real start/end, source scope and stable adopted revision with no private content',async () => {
  const root=temporary(),lease=enableRuntime(root),manager=ContextManager.open(root,undefined,immediate);
  const service=new MemoryService(manager,scope);
  try {
    const end=manager.runtime.operation({kind:'provider',scope,role:'retention',provider:'Clef',model:'clef-flash'});
    let snapshot=readRuntime(root,scope);
    assert.equal(snapshot.activities.length,1);assert.equal(snapshot.activities[0].kind,'provider');
    assert.equal(snapshot.instances[0].configRevision,configRevision(root));
    const foreign={agent:'kimi',workspaceId:scope.workspaceId};
    assert.equal(readRuntime(root,foreign).activities.length,0);
    end({status:'fallback'});end({status:'error'});
    snapshot=readRuntime(root,scope);assert.equal(snapshot.activities.length,0);
    assert.equal(snapshot.events.filter(e=>e.phase==='end').length,1);
    assert.equal(snapshot.events.at(-1)?.status,'fallback');
    const result=await service.capture({sessionId:'host-secret-session',toolName:'Read',input:'PRIVATE SOURCE CODE',result:'SECRET RAW OUTPUT'});
    const event=rowToToolEvent(service.event(result.eventId!));
    await manager.capsules.build(event);
    await manager.retention.decideAll([event],{pressure:0.9});
    snapshot=readRuntime(root,scope);
    for (const kind of ['capture','archive','index','chain','capsule','score']) assert.ok(snapshot.events.some(e=>e.kind===kind && e.phase==='end'),kind);
    assert.ok(snapshot.events.some(e=>e.eventId===result.eventId));
    const raw=slot(root).map(file=>fs.readFileSync(file,'utf8')).join('');
    for (const secret of ['PRIVATE SOURCE CODE','SECRET RAW OUTPUT','host-secret-session']) assert.ok(!raw.includes(secret));
    manager.close();assert.equal(readRuntime(root,scope).instances[0].state,'stopped');
  } finally {manager.close();lease.stop();remove(root);}
});

test('independent hook process observations are visible and terminate without a persistent heartbeat',async () => {
  const root=temporary(),lease=enableRuntime(root);
  try {
    const moduleUrl=new URL('../src/observability/runtime.js',import.meta.url).href;
    await child(`import {observeOperation} from ${JSON.stringify(moduleUrl)};
      const end=observeOperation(process.env.CMM_OBS_STORAGE,{kind:'capture',scope:${JSON.stringify(scope)}});end();`,root);
    const snapshot=readRuntime(root,scope);
    assert.equal(snapshot.instances.length,1);assert.equal(snapshot.instances[0].state,'stopped');
    assert.notEqual(snapshot.instances[0].pid,process.pid);assert.equal(snapshot.events.length,2);
    assert.equal(snapshot.events[1].phase,'end');assert.equal(snapshot.activities.length,0);
  } finally {lease.stop();remove(root);}
});

test('stale heartbeats never become running activities or PID liveness assertions; lease replacement isolates observation windows',() => {
  const root=temporary(),lease=enableRuntime(root),observer=createRuntimeObserver(root,{scope,persistent:false,...immediate});
  try {
    const end=observer.operation({kind:'archive'});
    const file=slot(root)[0],state=JSON.parse(fs.readFileSync(file,'utf8'));
    state.observedAt=Date.now()-RUNTIME_LIMITS.staleMs-1;state.pid=process.pid;
    fs.writeFileSync(file,JSON.stringify(state));
    const stale=readRuntime(root,scope);assert.equal(stale.instances[0].state,'stale');assert.equal(stale.activities.length,0);
    const second=enableRuntime(root);lease.stop();
    assert.equal(readRuntime(root,scope).enabled,true);assert.equal(readRuntime(root,scope).events.length,0);
    end();assert.equal(readRuntime(root,scope).events.length,0);
    const next=observer.operation({kind:'index'});next();
    assert.deepEqual(readRuntime(root,scope).events.map(e=>e.kind),['index','index']);
    const closing=createRuntimeObserver(root,{scope,persistent:false,...immediate});
    const third=enableRuntime(root);closing.close();
    assert.equal(readRuntime(root,scope).instances.length,0,'close cannot resurrect an instance in a replacement lease');
    third.stop();
    second.stop();const before=fs.readFileSync(slot(root).find(f=>JSON.parse(fs.readFileSync(f,'utf8')).leaseId===second.leaseId)!,'utf8');
    observer.operation({kind:'archive'})();
    assert.ok(slot(root).some(f=>fs.readFileSync(f,'utf8')===before));
    assert.equal(readRuntime(root,scope).activities.length,0);
  } finally {observer.close();lease.stop();remove(root);}
});

test('interrupted stale metadata can be recycled without touching the archive',() => {
  const root=temporary(),lease=enableRuntime(root);
  try {
    const runtime=path.join(root,'runtime');
    for(let i=0;i<RUNTIME_LIMITS.slots;i++) {
      const file=path.join(runtime,`slot-${String(i).padStart(3,'0')}.json`);
      fs.writeFileSync(file,'{interrupted');
      const old=new Date(Date.now()-RUNTIME_LIMITS.staleMs-1000);fs.utimesSync(file,old,old);
    }
    const untouched=path.join(root,'cmm.db');fs.writeFileSync(untouched,'synthetic archive sentinel');
    observeOperation(root,{kind:'capture',scope})();
    assert.equal(readRuntime(root,scope).events.length,2);
    assert.equal(fs.readFileSync(untouched,'utf8'),'synthetic archive sentinel');
    assert.equal(slot(root).length,RUNTIME_LIMITS.slots);
  } finally {lease.stop();remove(root);}
});

test('runtime data is bounded across hook churn, active operations, labels, and untrusted metadata files',() => {
  const root=temporary(),lease=enableRuntime(root),observer=createRuntimeObserver(root,{scope,persistent:false,...immediate});
  try {
    const ends=Array.from({length:40},()=>observer.operation({kind:'provider',provider:'sk-SECRET_API_KEY_123456789',model:'Bearer secret',role:'capsule'}));
    assert.equal(readRuntime(root,scope).activities.length,RUNTIME_LIMITS.activities);
    ends.forEach(end=>end());
    for (let i=0;i<200;i++) observeOperation(root,{kind:'index',scope,eventId:randomUUID()})();
    assert.ok(slot(root).length<=RUNTIME_LIMITS.slots);
    for (const file of slot(root)) assert.ok(fs.statSync(file).size<=RUNTIME_LIMITS.fileBytes);
    assert.ok(readRuntime(root,scope).events.length<=256);
    const file=slot(root).find(f=>JSON.parse(fs.readFileSync(f,'utf8')).instanceId===observer.instanceId)!;
    const value=JSON.parse(fs.readFileSync(file,'utf8'));
    value.rawError='PRIVATE STACK';value.prompt='PRIVATE PROMPT';value.events[0].rawSource='PRIVATE SOURCE';
    value.events[0].provider='sk-private-key-123456789';value.events[0].model='arbitrary user prose';
    fs.writeFileSync(file,JSON.stringify(value));
    const snapshot=JSON.stringify(readRuntime(root,scope));
    for (const secret of ['PRIVATE STACK','PRIVATE PROMPT','PRIVATE SOURCE','sk-private-key','arbitrary user prose']) assert.ok(!snapshot.includes(secret));
    assert.ok(readRuntime(root,scope).truncated);
  } finally {observer.close();lease.stop();remove(root);}
});

test('provider observation includes validation failures and preserves the original call ledger',async () => {
  const root=temporary(),lease=enableRuntime(root),observer=createRuntimeObserver(root,{scope,persistent:false});
  const records: {ok:boolean;tokensIn:number}[]=[];
  try {
    const response=await completeWithFailover([
      {name:'first',async complete(){return {text:'invalid secret response',tokensIn:9,tokensOut:2,model:'fixture-1'};}},
      {name:'second',async complete(){return {text:'valid',tokensIn:4,tokensOut:1,model:'fixture-2'};}}
    ],{user:'PRIVATE PROMPT'},{purpose:'retention',recordCall:r=>records.push(r),logger:createLogger(),
      validate:r=>{if(r.text!=='valid')throw new Error('SECRET RAW VALIDATION ERROR');},
      observe:a=>observer.operation({kind:'provider',role:a.purpose,provider:a.provider})});
    assert.equal(response.text,'valid');assert.deepEqual(records.map(r=>[r.ok,r.tokensIn]),[[false,9],[true,4]]);
    const snapshot=readRuntime(root,scope);
    assert.deepEqual(snapshot.events.filter(e=>e.phase==='end').map(e=>e.status),['error','ok']);
    assert.ok(!JSON.stringify(snapshot).includes('SECRET'));
  } finally {observer.close();lease.stop();remove(root);}
});

test('a conservative scoring fallback is observed even when its low score keeps the event',async () => {
  const root=temporary(),lease=enableRuntime(root),manager=ContextManager.open(root,undefined,immediate),service=new MemoryService(manager,scope);
  try {
    const saved=await service.capture({sessionId:'s',toolName:'Read',input:'x',result:'y'});
    const event=rowToToolEvent(service.event(saved.eventId!));
    if(event.chainId)manager.db.run('UPDATE chains SET status=? WHERE id=?',['completed',event.chainId]);
    manager.retention.primary={name:'controlled-failure',async score(){throw new Error('PRIVATE MODEL ERROR');}};
    manager.retention.fallback={name:'controlled-low-score',async score(){return 0.01;}};
    const decisions=await manager.retention.decideAll([event],{pressure:0.8});
    assert.equal(decisions[0].decision,'keep');
    assert.ok(!decisions[0].reason.includes('fallback'),'test covers the reason-string blind spot');
    assert.equal(readRuntime(root,scope).events.filter(e=>e.kind==='score'&&e.phase==='end').at(-1)?.status,'fallback');
    assert.ok(!JSON.stringify(readRuntime(root,scope)).includes('PRIVATE MODEL ERROR'));
  } finally {manager.close();lease.stop();remove(root);}
});

test('unpin rolls back intermediate writes and rechecks the source agent inside its transaction',async () => {
  const root=temporary(),manager=ContextManager.open(root),service=new MemoryService(manager,{...scope,shared:true});
  try {
    const saved=await service.capture({sessionId:'s',toolName:'Read',input:'x',result:'y'});const id=saved.eventId!;
    await service.pin(id,true);
    const update=manager.db.updateToolEvent.bind(manager.db);
    manager.db.updateToolEvent=(eventId,patch)=>{if(patch.pinned===0)throw new Error('injected flag update failure');return update(eventId,patch);};
    await assert.rejects(service.pin(id,false),/injected/);
    assert.equal(manager.db.listPinsForTarget('event',id).length,1);assert.equal(service.event(id).pinned,1);
    manager.db.updateToolEvent=update;
    const transaction=manager.db.transaction.bind(manager.db);manager.db.ensureAgent('kimi');
    manager.db.transaction=<T>(work:()=>T):T=>transaction(()=>{manager.db.run('UPDATE tool_events SET agent=? WHERE id=?',['kimi',id]);return work();});
    await assert.rejects(service.pin(id,false),/Cross-agent/);
    manager.db.transaction=transaction;
    assert.equal(service.event(id).agent,scope.agent);assert.equal(manager.db.listPinsForTarget('event',id).length,1);
    await service.pin(id,false);assert.equal(service.event(id).pinned,0);assert.equal(manager.db.listPinsForTarget('event',id).length,0);
  } finally {manager.close();remove(root);}
});

test('verify exposes progress, yields to cancellation, and preserves captured bytes and completeness',async () => {
  const root=temporary(),lease=enableRuntime(root),manager=ContextManager.open(root,undefined,immediate),service=new MemoryService(manager,scope);
  try {
    for(let i=0;i<20;i++)await service.capture({sessionId:'s',toolCallId:`call-${i}`,toolName:'Read',input:'synthetic input',result:`original-${i}`});
    const controller=new AbortController(),progress:VerificationProgress[]=[];
    setImmediate(()=>controller.abort());
    await assert.rejects(service.verify(true,{signal:controller.signal,onProgress:p=>progress.push(p)}),{name:'AbortError'});
    assert.ok(progress.some(p=>p.checked===8));assert.ok(progress.at(-1)!.checked<20);
    assert.equal(readRuntime(root,scope).events.filter(e=>e.kind==='reindex'&&e.phase==='end').at(-1)?.status,'cancelled');
    const before=manager.db.queryAll<{result_sha:string}>('SELECT result_sha FROM tool_events ORDER BY id');
    const finalProgress:VerificationProgress[]=[];
    const verified=await service.verify(false,{onProgress:p=>finalProgress.push(p)});
    assert.equal(verified.checked,20);assert.equal(verified.failed,0);assert.equal(finalProgress.at(-1)?.checked,20);
    assert.equal(finalProgress.at(-1)?.total,20);assert.equal(verified.databaseIntegrityOk,true);
    assert.deepEqual(manager.db.queryAll('SELECT result_sha FROM tool_events ORDER BY id'),before);
    const provenance=manager.db.queryAll<{json:string}>('SELECT json FROM evidence_provenance');
    assert.ok(provenance.every(row=>JSON.parse(row.json).completeness==='unknown'));
    const aborted=new AbortController();aborted.abort();
    await assert.rejects(service.verify(false,{signal:aborted.signal}),{name:'AbortError'});
  } finally {manager.close();lease.stop();remove(root);}
});
