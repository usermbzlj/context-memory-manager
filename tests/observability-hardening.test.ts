import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsDefault from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ContextManager } from '../src/core/context-manager.js';
import { MemoryService } from '../src/runtime/memory.js';
import { rowToToolEvent } from '../src/types.js';
import { createRuntimeObserver, enableRuntime, readRuntime, RUNTIME_LIMITS } from '../src/observability/runtime.js';

const scope={agent:'codex',workspaceId:'synthetic-hardening-workspace'};
const immediate={publishMs:0,leaseCacheMs:0};
const temporary=()=>fs.mkdtempSync(path.join(os.tmpdir(),'cmm-obs-hardening-'));
const remove=(root:string)=>fs.rmSync(root,{recursive:true,force:true});
const slotFile=(root:string,index:number)=>path.join(root,'runtime',`slot-${String(index).padStart(3,'0')}.json`);
const slots=(root:string)=>fs.readdirSync(path.join(root,'runtime')).filter(name=>name.startsWith('slot-')).map(name=>path.join(root,'runtime',name));
const read=(file:string)=>JSON.parse(fs.readFileSync(file,'utf8'));
const ownSlot=(root:string,instanceId:string)=>slots(root).find(file=>{try{return read(file).instanceId===instanceId;}catch{return false;}});
/** Counts calls to a real fs function (ESM namespace re-synced) while forwarding to it. */
function spy(t:{after(fn:()=>void):void},name:'openSync'|'renameSync',match:(file:string)=>boolean):{count:number} {
  const original=(fsDefault as any)[name] as (...args:any[])=>unknown,counter={count:0};
  (fsDefault as any)[name]=(...args:any[])=>{if(match(String(args[0])))counter.count++;return original(...args);};
  syncBuiltinESMExports();
  t.after(()=>{(fsDefault as any)[name]=original;syncBuiltinESMExports();});
  return counter;
}

test('with a live lease, slot writes that always fail never break capture, recall, close or provider paths',async () => {
  const root=temporary(),lease=enableRuntime(root);
  try {
    for(let i=0;i<RUNTIME_LIMITS.slots;i++)fs.mkdirSync(slotFile(root,i));
    const manager=ContextManager.open(root,undefined,immediate),service=new MemoryService(manager,scope);
    assert.equal(readRuntime(root,scope).enabled,true);
    const started=Date.now();
    for(let i=0;i<300;i++)manager.runtime.operation({kind:'provider',scope,provider:'p'})({status:'error'});
    assert.ok(Date.now()-started<2500,'denied channels back off instead of probing on every operation');
    const saved=await service.capture({sessionId:'s',toolName:'Read',input:'private input',result:'private result'});
    assert.equal(saved.archived,true);
    assert.equal((await service.recall(saved.eventId!)).text,'private result');
    assert.equal(readRuntime(root,scope).instances.length,0);
    manager.close();
  } finally {lease.stop();remove(root);}
});

test('a slot that turns into an unwritable directory after claiming is tolerated by operations, heartbeat and close',async () => {
  const root=temporary(),lease=enableRuntime(root),observer=createRuntimeObserver(root,{scope,persistent:false,...immediate});
  try {
    observer.operation({kind:'archive'})();
    const file=ownSlot(root,observer.instanceId)!;assert.ok(file);
    fs.rmSync(file);fs.mkdirSync(file);
    assert.doesNotThrow(()=>{observer.operation({kind:'index'})();observer.flush();observer.update({configRevision:'rev'});observer.close();});
    assert.ok(fs.statSync(file).isDirectory());
  } finally {lease.stop();remove(root);}
});

test('a failed lease read means unknown: the heartbeat keeps running, and an idle process reappears under a later lease',async t => {
  t.mock.timers.enable({apis:['setInterval','Date'],now:Date.now()});
  const root=temporary(),lease=enableRuntime(root),observer=createRuntimeObserver(root,{component:'bridge',scope});
  try {
    const first=ownSlot(root,observer.instanceId)!;assert.ok(first);
    const lastBeat=()=>read(first).observedAt as number;
    const seen=lastBeat();
    // The lease file is unreadable (corrupt) during several beats of an otherwise idle process.
    const leaseFile=path.join(root,'runtime','observer.json'),valid=fs.readFileSync(leaseFile,'utf8');
    // The dashboard (which would repair a corrupt lease on its own beat) is stopped, so only observers react to the damage.
    lease.stop();fs.writeFileSync(leaseFile,'{ torn');
    let previous=seen;
    for(let beat=0;beat<3;beat++){t.mock.timers.tick(RUNTIME_LIMITS.heartbeatMs);assert.ok(lastBeat()>previous,`beat ${beat} must still publish`);previous=lastBeat();}
    fs.writeFileSync(leaseFile,JSON.stringify({...JSON.parse(valid),observedAt:Date.now()}));
    t.mock.timers.tick(RUNTIME_LIMITS.heartbeatMs);assert.ok(lastBeat()>previous);
    // A genuinely vanished dashboard stops the writes after the lease window, but the beat stays armed.
    fs.rmSync(leaseFile);lease.stop();
    for(let elapsed=0;elapsed<=RUNTIME_LIMITS.leaseMs+RUNTIME_LIMITS.heartbeatMs;elapsed+=RUNTIME_LIMITS.heartbeatMs)t.mock.timers.tick(RUNTIME_LIMITS.heartbeatMs);
    const frozen=lastBeat();t.mock.timers.tick(RUNTIME_LIMITS.heartbeatMs);assert.equal(lastBeat(),frozen);
    const replacement=enableRuntime(root);
    t.mock.timers.tick(RUNTIME_LIMITS.heartbeatMs);
    const reborn=readRuntime(root,scope);
    assert.equal(reborn.leaseId,replacement.leaseId);
    assert.ok(reborn.instances.some(instance=>instance.instanceId===observer.instanceId&&instance.leaseId===replacement.leaseId&&instance.state==='idle'),
      'idle serve/bridge/proxy processes show up again without needing a new operation');
    replacement.stop();
  } finally {observer.close();lease.stop();remove(root);}
});

test('close always attempts the stopped marker, even when the lease cannot be read at that moment',() => {
  const root=temporary(),lease=enableRuntime(root),observer=createRuntimeObserver(root,{scope,persistent:false,...immediate});
  try {
    observer.operation({kind:'archive'})();
    const file=ownSlot(root,observer.instanceId)!;
    fs.writeFileSync(path.join(root,'runtime','observer.json'),'{ torn');
    observer.close();
    const value=read(file);
    assert.ok(value.stoppedAt>0);assert.deepEqual(value.activities,[]);
    assert.ok(!fs.readdirSync(path.join(root,'runtime')).some(name=>name.startsWith('.tmp-')),'no temporary files are left behind');
  } finally {lease.stop();remove(root);}
});

test('writes replace atomically: concurrent readers never see an empty or partial slot',async () => {
  const root=temporary(),lease=enableRuntime(root),observer=createRuntimeObserver(root,{scope,persistent:false,...immediate});
  try {
    observer.operation({kind:'archive'})();
    const file=ownSlot(root,observer.instanceId)!;
    const reader=spawn(process.execPath,['--input-type=module','-e',`import fs from 'node:fs';
      const file=process.env.CMM_SLOT;let reads=0,bad=0;const stop=Date.now()+1500;
      while(Date.now()<stop){try{const text=fs.readFileSync(file,'utf8');reads++;JSON.parse(text);}catch(error){if(error.code==='ENOENT'||error.code==='EPERM'||error.code==='EBUSY'||error.code==='EACCES')continue;bad++;}}
      console.log(JSON.stringify({reads,bad}));`],{env:{...process.env,CMM_SLOT:file},windowsHide:true,stdio:['ignore','pipe','pipe']});
    let out='';reader.stdout.on('data',chunk=>{out+=chunk;});
    const finished=new Promise<void>(resolve=>reader.on('close',()=>resolve()));
    const until=Date.now()+1200;
    while(Date.now()<until){for(let i=0;i<40;i++)observer.operation({kind:'index',scope,eventId:randomUUID()})();await new Promise(resolve=>setImmediate(resolve));}
    await finished;
    const result=JSON.parse(out);
    assert.ok(result.reads>50);assert.equal(result.bad,0,'readers saw a truncated or partial slot');
  } finally {observer.close();lease.stop();remove(root);}
});

test('hook churn: 200 sequential short-lived instances under one lease stay within 128 files and are each observed',() => {
  const root=temporary(),lease=enableRuntime(root);
  try {
    for(let i=0;i<200;i++) {
      const observer=createRuntimeObserver(root,{component:'hook',scope,persistent:false});
      observer.operation({kind:'capture'})();
      if(i%20===0||i>=195)assert.ok(ownSlot(root,observer.instanceId),`instance ${i} was observed`);
      observer.close();
      if(i%20===0||i>=195)assert.ok(read(ownSlot(root,observer.instanceId)!).stoppedAt>0,'a finished hook is immediately reclaimable');
    }
    assert.ok(slots(root).length<=RUNTIME_LIMITS.slots);
    assert.equal(readRuntime(root,scope).instances.every(instance=>instance.state==='stopped'),true);
    for(const file of slots(root))assert.ok(fs.statSync(file).size<=RUNTIME_LIMITS.fileBytes);
  } finally {lease.stop();remove(root);}
});

test('slot allocation is one bounded probe pass regardless of how full the table is',t => {
  const root=temporary(),lease=enableRuntime(root);
  try {
    const stopped={version:1,leaseId:lease.leaseId,pid:1,component:'hook',source:'runtime-file',startedAt:1,observedAt:Date.now(),stoppedAt:Date.now(),activities:[],events:[],dropped:0};
    for(let i=0;i<RUNTIME_LIMITS.slots;i++)fs.writeFileSync(slotFile(root,i),JSON.stringify({...stopped,instanceId:randomUUID()}));
    const slotOpens=spy(t,'openSync',file=>path.basename(file).startsWith('slot-'));
    const reclaimed=createRuntimeObserver(root,{scope,persistent:false});
    assert.ok(slotOpens.count<=3,`a stopped slot is reclaimed in place on the first probe (${slotOpens.count} opens)`);
    assert.ok(ownSlot(root,reclaimed.instanceId));
    reclaimed.close();
    // Now every slot is a live, current instance: nothing is reclaimable, so the process skips observation quickly.
    const live={...stopped,stoppedAt:undefined};
    for(let i=0;i<RUNTIME_LIMITS.slots;i++)fs.writeFileSync(slotFile(root,i),JSON.stringify({...live,instanceId:randomUUID(),observedAt:Date.now()}));
    slotOpens.count=0;
    const skipped=createRuntimeObserver(root,{scope,persistent:false});
    assert.ok(slotOpens.count<=RUNTIME_LIMITS.probes*2,`probe cap holds (${slotOpens.count} opens)`);
    assert.equal(ownSlot(root,skipped.instanceId),undefined);
    assert.doesNotThrow(()=>{skipped.operation({kind:'capture'})();skipped.close();});
    assert.equal(slots(root).length,RUNTIME_LIMITS.slots);
  } finally {lease.stop();remove(root);}
});

test('over-long workspace ids and labels never push a publish over 64 KiB; the instance stays fresh',() => {
  const root=temporary(),lease=enableRuntime(root),observer=createRuntimeObserver(root,{scope,persistent:false,...immediate});
  try {
    // 4096-char ids are digested (the dashboard filter is digested identically) ...
    const huge={agent:'codex',workspaceId:'w'.repeat(4096)};
    const ends=Array.from({length:RUNTIME_LIMITS.activities},()=>observer.operation({kind:'provider',scope:huge,role:'capsule',provider:'p'.repeat(100),model:'m'.repeat(100),eventId:randomUUID()}));
    const file=ownSlot(root,observer.instanceId)!;
    assert.ok(fs.statSync(file).size<=RUNTIME_LIMITS.fileBytes);
    const busy=readRuntime(root,huge);
    assert.equal(busy.activities.length,RUNTIME_LIMITS.activities);
    assert.equal(busy.instances.find(i=>i.instanceId===observer.instanceId)?.state,'busy');
    ends.forEach(end=>end());
    assert.ok(readRuntime(root,huge).events.some(e=>e.phase==='end'),'scoped snapshots still match digested ids');
    assert.equal(readRuntime(root,{agent:'codex',workspaceId:'x'.repeat(4096)}).events.length,0);
    // ... and ids just under the digest threshold (256 chars) overflow by volume, which is shed oldest-first.
    const wide={agent:'a'.repeat(200),workspaceId:'w'.repeat(256)};
    const wideEnds=Array.from({length:RUNTIME_LIMITS.activities},()=>observer.operation({kind:'provider',scope:wide,role:'capsule',provider:'p'.repeat(100),model:'m'.repeat(100),eventId:randomUUID()}));
    for(let i=0;i<5;i++)observer.operation({kind:'provider',scope:wide,provider:'p'.repeat(100),model:'m'.repeat(100),eventId:randomUUID()})();
    assert.ok(fs.statSync(file).size<=RUNTIME_LIMITS.fileBytes,'file fits the bound');
    wideEnds.forEach(end=>end());
    assert.ok(fs.statSync(file).size<=RUNTIME_LIMITS.fileBytes);
    const value=read(file);
    assert.ok(value.dropped>0);assert.ok(Date.now()-value.observedAt<RUNTIME_LIMITS.staleMs);
    assert.equal(readRuntime(root).instances.find(i=>i.instanceId===observer.instanceId)?.stale,false);
    assert.equal(readRuntime(root).truncated,true);
  } finally {observer.close();lease.stop();remove(root);}
});

test('bursts are coalesced to about one write per 250 ms and the trailing flush is guaranteed',async t => {
  const root=temporary(),lease=enableRuntime(root),observer=createRuntimeObserver(root,{scope});
  try {
    const writes=spy(t,'renameSync',file=>path.basename(file).startsWith('.tmp-slot-'));
    const started=Date.now();
    for(let i=0;i<60;i++)observer.operation({kind:'index',scope,eventId:randomUUID()})();
    const burstMs=Date.now()-started;
    assert.ok(writes.count<=Math.ceil(burstMs/RUNTIME_LIMITS.publishMs)+1,`${writes.count} writes for a ${burstMs} ms burst`);
    assert.ok(writes.count>=1,'the spy sees the writes: the first publish of a burst is immediate');
    await new Promise(resolve=>setTimeout(resolve,RUNTIME_LIMITS.publishMs*3));
    const events=readRuntime(root,scope).events;
    assert.equal(events.length,RUNTIME_LIMITS.events);
    assert.equal(events.at(-1)?.phase,'end');
    const before=writes.count;
    assert.ok(before>=2,'the trailing flush after the burst is a counted write too');
    await new Promise(resolve=>setTimeout(resolve,RUNTIME_LIMITS.publishMs*2));
    assert.equal(writes.count,before,'idle coalescing leaves no repeating writer (the beat is the heartbeat only)');
  } finally {observer.close();lease.stop();remove(root);}
});

test('short-lived processes flush at the end of the outermost operation and exit without waiting for timers',async () => {
  const root=temporary(),lease=enableRuntime(root);
  try {
    const moduleUrl=new URL('../src/observability/runtime.js',import.meta.url).href;
    const run=(source:string)=>new Promise<number>((resolve,reject)=>{
      const peer=spawn(process.execPath,['--input-type=module','-e',source],{env:{...process.env,CMM_OBS_STORAGE:root},windowsHide:true,stdio:['ignore','pipe','pipe']});
      const started=Date.now();let error='';peer.stderr.on('data',chunk=>{error+=chunk;});
      peer.on('error',reject);peer.on('close',code=>code===0?resolve(Date.now()-started):reject(new Error(error)));
    });
    // No close(): only the unref'd heartbeat/coalescing timers exist, which must not hold the process open.
    await run(`import {createRuntimeObserver} from ${JSON.stringify(moduleUrl)};
      const o=createRuntimeObserver(process.env.CMM_OBS_STORAGE,{component:'bridge',scope:${JSON.stringify(scope)}});
      const outer=o.operation({kind:'capture'});o.operation({kind:'archive'})();outer();`);
    const snapshot=readRuntime(root,scope);
    assert.ok(snapshot.events.length>=1,'the first publish happens immediately');
    const hook=await run(`import {createRuntimeObserver} from ${JSON.stringify(moduleUrl)};
      const o=createRuntimeObserver(process.env.CMM_OBS_STORAGE,{component:'hook',scope:${JSON.stringify(scope)},persistent:false});
      const outer=o.operation({kind:'capture'});o.operation({kind:'archive'})();outer();`);
    assert.ok(hook<5000);
    const ended=readRuntime(root,scope).events.filter(e=>e.phase==='end'&&e.kind==='capture');
    assert.equal(ended.length,1,'the outermost end of a non-persistent process is flushed before it exits (no close call)');
  } finally {lease.stop();remove(root);}
});

test('operation statuses: chain failure is an error, scorer/capsule degradations are explicit flags, not reason-string guesses',async () => {
  const root=temporary(),lease=enableRuntime(root),manager=ContextManager.open(root,undefined,immediate),service=new MemoryService(manager,scope);
  try {
    const last=(kind:string)=>readRuntime(root,scope).events.filter(e=>e.kind===kind&&e.phase==='end').at(-1)?.status;
    const original=manager.linker.linkEvent.bind(manager.linker);
    manager.linker.linkEvent=async()=>{throw new Error('PRIVATE CHAIN FAILURE');};
    const saved=await service.capture({sessionId:'s',toolName:'Read',input:'x',result:'y'});
    assert.equal(saved.archived,true);
    assert.equal(last('chain'),'error');
    assert.ok(!JSON.stringify(readRuntime(root,scope)).includes('PRIVATE'));
    manager.linker.linkEvent=original;

    // A capsule build failure keeps the event; the capsule op errors and the score op is marked degraded explicitly.
    const second=await service.capture({sessionId:'s',toolName:'Read',input:'x2',result:'y2'});
    const event=rowToToolEvent(service.event(second.eventId!));
    if(event.chainId)manager.db.run('UPDATE chains SET status=? WHERE id=?',['completed',event.chainId]);
    manager.retention.primary={name:'scripted',async score(){return 0.7;}};
    manager.capsules.failNextBuild();
    const kept=await manager.retention.decideAll([event],{pressure:0.8});
    assert.equal(kept[0].reason,'capsule-failed');
    assert.equal(last('capsule'),'error');assert.equal(last('score'),'fallback');

    // A healthy scorer decision whose reason merely contains the word "fallback" is not a fallback.
    const third=await service.capture({sessionId:'s',toolName:'Read',input:'x3',result:'y3'});
    const clean=rowToToolEvent(service.event(third.eventId!));
    if(clean.chainId)manager.db.run('UPDATE chains SET status=? WHERE id=?',['completed',clean.chainId]);
    manager.retention.primary={name:'conservative-fallback-lookalike',async score(){return 0.2;}};
    const decisions=await manager.retention.decideAll([clean],{pressure:0.8});
    assert.match(decisions[0].reason,/fallback scorer|score 0\.200/);
    assert.equal(last('score'),'ok');

    // A model that invents anchors is overridden by the deterministic draft: the capsule op reports a fallback.
    (manager.capsules as any).opts.cheapModel={name:'inventing',async refine(draft:any){return {...draft,anchors:[...draft.anchors,'invented/path.ts']};}};
    await manager.capsules.build(clean);
    assert.equal(last('capsule'),'fallback');
  } finally {manager.close();lease.stop();remove(root);}
});

const temporaries=(root:string)=>fs.readdirSync(path.join(root,'runtime')).filter(name=>name.startsWith('.tmp-'));

test('a failed temporary write or rename never leaves a .tmp file behind',t => {
  const root=temporary(),lease=enableRuntime(root),observer=createRuntimeObserver(root,{scope,persistent:false,...immediate});
  try {
    observer.operation({kind:'archive'})();
    assert.ok(ownSlot(root,observer.instanceId));
    // Disk full: some bytes reach the temporary file, then the write throws.
    const write=fsDefault.writeFileSync,rename=fsDefault.renameSync;
    (fsDefault as any).writeFileSync=(file:any,...rest:any[])=>{
      if(!path.basename(String(file)).startsWith('.tmp-slot-'))return (write as any)(file,...rest);
      (write as any)(file,'{"partial"',{flag:'wx'});throw Object.assign(new Error('disk full'),{code:'ENOSPC'});
    };
    syncBuiltinESMExports();
    t.after(()=>{(fsDefault as any).writeFileSync=write;(fsDefault as any).renameSync=rename;syncBuiltinESMExports();});
    for(let i=0;i<3;i++){assert.doesNotThrow(()=>{observer.operation({kind:'index'})();observer.flush();});}
    assert.deepEqual(temporaries(root),[],'a failed temporary write is removed');
    // Persistent EPERM on the rename (retries exhausted).
    (fsDefault as any).writeFileSync=write;
    (fsDefault as any).renameSync=(from:any,...rest:any[])=>{
      if(path.basename(String(from)).startsWith('.tmp-slot-'))throw Object.assign(new Error('denied'),{code:'EPERM'});
      return (rename as any)(from,...rest);
    };
    syncBuiltinESMExports();
    assert.doesNotThrow(()=>{observer.operation({kind:'index'})();observer.flush();});
    assert.deepEqual(temporaries(root),[],'a temporary whose rename keeps failing is removed');
  } finally {lease.stop();remove(root);}
});

test('slot claiming removes a bounded number of stale orphan temporaries and never a fresh one',() => {
  const root=temporary(),lease=enableRuntime(root);
  try {
    const dir=path.join(root,'runtime'),old=new Date(Date.now()-5*60_000);
    for(let i=0;i<12;i++){const file=path.join(dir,`.tmp-slot-000.json-old${String(i).padStart(2,'0')}`);fs.writeFileSync(file,'{}');fs.utimesSync(file,old,old);}
    const fresh=path.join(dir,'.tmp-slot-000.json-zfresh');fs.writeFileSync(fresh,'{}');
    const first=createRuntimeObserver(root,{scope,persistent:false});first.operation({kind:'archive'})();first.close();
    const left=temporaries(root).filter(name=>name.includes('-old')).length;
    assert.ok(left<12&&left>=4,`one claim removes a few, at most 8 (${12-left} removed)`);
    for(let i=0;i<3;i++){const next=createRuntimeObserver(root,{scope,persistent:false});next.operation({kind:'archive'})();next.close();}
    assert.deepEqual(temporaries(root),['.tmp-slot-000.json-zfresh'],'orphans disappear without a dashboard restart; the fresh file stays');
  } finally {lease.stop();remove(root);}
});

test('a corrupt or unusable lease file is rewritten by the dashboard heartbeat; a foreign dashboard lease is not',t => {
  t.mock.timers.enable({apis:['setInterval','Date'],now:Date.now()});
  const root=temporary(),lease=enableRuntime(root),leaseFile=path.join(root,'runtime','observer.json');
  try {
    for(const garbage of ['{ torn','','null','[]','{"version":1}','"text"']){
      fs.writeFileSync(leaseFile,garbage);
      assert.equal(readRuntime(root).enabled,false,`${JSON.stringify(garbage)} is not a lease`);
      t.mock.timers.tick(RUNTIME_LIMITS.heartbeatMs);
      const snapshot=readRuntime(root);
      assert.equal(snapshot.enabled,true,`${JSON.stringify(garbage)} is replaced on the next beat`);
      assert.equal(snapshot.leaseId,lease.leaseId);
    }
    const foreign={version:1,leaseId:randomUUID(),observedAt:Date.now()};
    fs.writeFileSync(leaseFile,JSON.stringify(foreign));
    t.mock.timers.tick(RUNTIME_LIMITS.heartbeatMs);
    assert.equal(read(leaseFile).leaseId,foreign.leaseId,'another dashboard keeps its lease');
    assert.deepEqual(temporaries(root),[]);
  } finally {lease.stop();remove(root);}
});
