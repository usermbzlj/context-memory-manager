import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MemoryService, sessionKey } from '../src/runtime/memory.js';
import { BlobStore } from '../src/storage/blob-store.js';
import { makeManager, cleanup, sampleInput, getEventByCallId, pressured } from './util.js';
import { rowToToolEvent } from '../src/types.js';
import { JevScorer } from '../src/scoring/jev.js';
import { FakeProvider } from '../src/providers/fake.js';
import { estimateTokens, isSideEffectTool, buildDescriptor } from '../src/descriptor.js';
import { loadConfig } from '../src/config.js';

async function fixture(t:TestContext,overrides:Record<string,unknown>={}) {
  const {manager,dir}=await makeManager(overrides);t.after(()=>cleanup(dir,manager));
  return {manager,dir,service:new MemoryService(manager,{agent:'test',workspaceId:dir})};
}
const big='header\n'+'evidence and repeated log data\n'.repeat(3000)+'\nSUMMARY: 3000 passed, 0 failed; Exit code: 0\n';
async function add(service:MemoryService,result=big,sessionId='session',call='call') {
  const saved=await service.capture({sessionId,toolCallId:call,toolName:'Read',input:'artifacts/test.log',result});
  assert.equal(saved.archived,true,saved.error ?? "capture failed");return saved.eventId!;
}

test('event identity is scoped to session; conflicting retries never overwrite evidence',async t=>{
  const {manager,service}=await fixture(t);
  const first=await add(service,'first');
  const retry=await service.capture({sessionId:'session',toolCallId:'call',toolName:'Read',input:'artifacts/test.log',result:'different'});
  assert.equal(retry.archived,false);assert.match(retry.error ?? '',/conflict/i);
  assert.equal((await service.recall(first)).text,'first');
  const second=await add(service,'second','another-session');assert.notEqual(second,first);
  assert.throws(()=>manager.db.getToolEventByCallId('test',service.scope.workspaceId,'call'),/ambiguous/i);
  assert.equal(service.lookup('session','call','Read')?.eventId,first);
  assert.equal(service.lookup('session','call','Bash'),null);
});
test('duplicate observations do not advance turns or multiply rows',async t=>{
  const {manager,service}=await fixture(t);const one=await add(service,'same');const two=await add(service,'same');
  assert.equal(one,two);assert.equal(manager.db.getCurrentTurn(sessionKey(service.scope,'session')),1);
  assert.equal(service.search().results.length,1);
});
test('agent and workspace scopes are isolated; shared access is explicit and workspace-only',async t=>{
  const {manager,service,dir}=await fixture(t);const id=await add(service,'needle evidence');
  const other=new MemoryService(manager,{agent:'other',workspaceId:dir});assert.equal(other.search('needle').results.length,0);assert.throws(()=>other.event(id));
  const shared=new MemoryService(manager,{agent:'other',workspaceId:dir,shared:true});assert.equal(shared.search('needle').results[0].eventId,id);
  const otherWorkspace=new MemoryService(manager,{agent:'test',workspaceId:dir+'/other',shared:true});assert.throws(()=>otherWorkspace.event(id));
  assert.notEqual(sessionKey(service.scope,'same-host-id'),sessionKey(other.scope,'same-host-id'));
});
test('paged Unicode, CRLF and NUL recall reassembles exact input/output without splitting surrogate pairs',async t=>{
  const {service}=await fixture(t);const raw=('\u4f60\u597d\ud83d\ude80\r\n\u0000').repeat(100);const id=await add(service,raw);
  let all='',offset=0,pages=0;
  while(true) {const page=await service.recall(id,{offset,limit:3});all+=page.text;pages++;if(page.nextOffset===null)break;offset=page.nextOffset;}
  assert.equal(all,raw);assert.ok(pages>100);await assert.rejects(()=>service.recall(id,{offset:3}),/splits/);
  assert.equal((await service.recall(id,{field:'input'})).text,'artifacts/test.log');
});
test('partial recall is read-only; restoring a whole result creates a separate protected view',async t=>{
  const {manager,service}=await fixture(t);const id=await add(service,'123456789');
  manager.db.updateToolEvent(id,{state:'evicted'});const source=service.event(id).session_id;
  await service.recall(id,{limit:2});assert.equal(service.event(id).state,'evicted');
  await assert.rejects(()=>service.recall(id,{limit:2,restore:true}),/complete/);
  await service.recall(id,{restore:true,sessionId:'new'});
  assert.equal(service.event(id).session_id,source);assert.equal(service.event(id).state,'evicted');
  assert.equal(manager.db.getEventView(id,sessionKey(service.scope,'new'))?.state,'hot');
  assert.equal(manager.db.listEvents(sessionKey(service.scope,'new'))[0].state,'hot');
});
test('search treats FTS and SQL metacharacters as data and supports Unicode evidence',async t=>{
  const {service}=await fixture(t);const id=await add(service,'\u6570\u636e\u5e93\u6545\u969c\u5df2\u4fee\u590d\nunique_archive_evidence');
  assert.equal(service.search('unique_archive_evidence').results[0].eventId,id);
  assert.equal(service.search('\u6570\u636e\u5e93').results[0].eventId,id);
  assert.doesNotThrow(()=>service.search('" OR * --'));assert.doesNotThrow(()=>service.search("'; DROP TABLE tool_events; --"));
  assert.equal(service.search().results.length,1);assert.throws(()=>service.search('q',51));
});
test('projection is bounded, genuinely smaller, searchable and recoverable',async t=>{
  const {service}=await fixture(t,{integration:{maxOutputChars:1024,minSavingsChars:200,ingressCompression:true}});const id=await add(service);
  const p=await service.project(id,big,'ingress');assert.ok(p.replaced);assert.ok(p.text.length<=1024);assert.match(p.text,/context_recall/);
  assert.ok(service.search('SUMMARY').results.some(r=>r.eventId===id));assert.equal((await service.verify()).failed,0);
  assert.equal(service.status().projectionReceipts?.originalChars,big.length);
});
test('no projection when the caller output changed or savings are too small',async t=>{
  const {service}=await fixture(t);const id=await add(service);
  const changed=await service.project(id,big+'new bytes','ingress');assert.equal(changed.replaced,false);assert.equal(changed.text,big+'new bytes');
  const small=await add(service,'short','session','small');assert.equal((await service.project(small,'short','ingress')).replaced,false);
});
test('pin restores our previous history projection while preserving the exact captured original',async t=>{
  const {manager,service}=await fixture(t);const id=await add(service);manager.db.updateToolEvent(id,{state:'capsule'});
  const p=await service.project(id,big,'history','session');assert.ok(p.replaced);
  await service.pin(id,true);const restored=await service.project(id,p.text,'history','session');
  assert.equal(restored.text,big);assert.ok(restored.replaced);assert.equal(service.event(id).pinned,1);
  await service.pin(id,false);assert.equal(service.event(id).pinned,0);
});
test('capture-only mode never projects or tidies outputs',async t=>{
  const {service}=await fixture(t,{integration:{captureOnly:true}});const id=await add(service);
  assert.equal((await service.project(id,big,'ingress')).replaced,false);
  assert.deepEqual(await service.transform('session',[{eventId:id,output:big}],{usedTokens:199999}),{tidy:null,projections:[]});
});
test('OpenCode captures protect newly observed outputs for their first consumption window',async t=>{
  const {service}=await fixture(t);
  const saved=await service.capture({sessionId:'s',toolCallId:'c',toolName:'Read',input:'x',result:big},'opencode');
  assert.equal((await service.project(saved.eventId!,big,'ingress','s')).replaced,false);
});
test('corrupt external blob blocks projection and verification reports the exact event',async t=>{
  const {service,dir}=await fixture(t);const id=await add(service);const row=service.event(id);
  fs.writeFileSync(path.join(dir,'blobs',row.result_ref),'corrupt');
  await assert.rejects(()=>service.project(id,big,'ingress'),/integrity/);const result=await service.verify();assert.equal(result.failed,1);assert.equal(result.failures[0].eventId,id);
});
test('inline integrity and canonical blob paths are verified; malformed UTF-16 is refused',async t=>{
  const {service,manager,dir}=await fixture(t);const id=await add(service,'inline');manager.db.updateToolEvent(id,{result_ref:'tampered'});
  await assert.rejects(()=>service.recall(id),/integrity/);
  const blobs=new BlobStore(path.join(dir,'extra'),0);const ref=blobs.put('valid');assert.throws(()=>blobs.get({...ref,ref:'../'+ref.ref}),/canonical/);
  assert.throws(()=>blobs.put('\uD800'),/UTF|surrogate|Unicode/i);
});
test('an already-existing corrupt hash file cannot count as an archived duplicate',async t=>{
  const {dir}=await fixture(t);const blobs=new BlobStore(path.join(dir,'extra'),0);const ref=blobs.put('same text');
  fs.writeFileSync(blobs.blobFilePath(ref),'bad');assert.throws(()=>blobs.put('same text'),/integrity/);
});
test('terminal output tail and structured stdout retain failure and test facts',async()=>{
  const result='noise\n'.repeat(5000)+'\nSUMMARY: 2 failed, 50 passed\nExit code: 2\n';
  const d=buildDescriptor('Bash','npm run build 2>&1 | tee build.log',JSON.stringify({stdout:result,stderr:'',exitCode:2}),'error');
  assert.equal(d.isSideEffect,true);assert.match(d.testVerdict ?? '',/2 failed/);
  assert.ok(estimateTokens('\u6d4b\u8bd5'.repeat(100))>estimateTokens('ab'.repeat(100)));
  assert.equal(isSideEffectTool('Bash','cat README.md > erased.txt'),true);
});
test('invalid provider JSON fails over to the next provider, rather than counting as success',async t=>{
  const {manager}=await fixture(t);await manager.recordToolComplete(sampleInput({toolName:'Read'}));
  const event=rowToToolEvent(manager.db.listEvents('s1')[0]);const records:any[]=[];
  const scorer=new JevScorer({providers:[new FakeProvider('bad','{"safeToEvict":"0.99"}'),new FakeProvider('good','{"safeToEvict":0.4}')],recordCall:r=>records.push(r),logger:manager.logger});
  assert.equal(await scorer.score(event,{currentTurn:20,pressure:1,recentDescriptors:[]}),0.4);
  assert.equal(records.length,2);assert.equal(records[0].ok,false);assert.equal(records[1].ok,true);assert.equal(records[1].costUsd,0);
});
test('NaN custom scorer never evicts an event',async t=>{
  const {manager}=await fixture(t,{strategy:'aggressive'});await manager.recordToolComplete(sampleInput({toolName:'Read',toolCallId:'nan'}));
  manager.retention.primary={name:'invalid',async score(){return NaN;}};pressured(manager,'s1');const tidy=await manager.maybeTidy('s1');
  assert.ok(tidy.decisions.every(d=>d.decision!=='evict'));assert.notEqual(getEventByCallId(manager,'nan')?.state,'evicted');
});
test('pin arriving while an asynchronous scorer runs wins over its stale result',async t=>{
  const {manager}=await fixture(t,{strategy:'aggressive'});await manager.recordToolComplete(sampleInput({toolName:'Read',toolCallId:'race'}));
  let started!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>started=r),barrier=new Promise<void>(r=>release=r);
  manager.retention.primary={name:'slow',async score(){started();await barrier;return 1;}};
  const event=getEventByCallId(manager,'race')!;const promise=manager.retention.decide(event,{pressure:1});await entered;
  await manager.pin({toolCallId:'race',agent:'test-agent',workspaceId:'/test/ws'});release();
  assert.equal((await promise).decision,'keep');assert.equal(getEventByCallId(manager,'race')?.state,'hot');
});
test('GC cannot starve behind protected old events or delete shared content still referenced',async t=>{
  const {manager,service}=await fixture(t,{storage:{maxSizeBytes:1}});const first=await add(service,big,'s','first');await service.pin(first,true);
  for(let i=0;i<60;i++) {const id=await add(service,'cold '+i,'s','cold'+i);manager.db.updateToolEvent(id,{state:'evicted'});if(i<55)await service.pin(id,true);}
  const gc=await manager.gc();assert.equal(gc.deletedEvents,5);assert.equal((await service.recall(first,{limit:10})).text,big.slice(0,10));
});
test('invalid config is not silently replaced with defaults',async t=>{
  const {dir}=await fixture(t);fs.writeFileSync(path.join(dir,'config.json'),'{ broken');assert.throws(()=>loadConfig(dir),/not reset/);
  assert.equal(fs.readFileSync(path.join(dir,'config.json'),'utf8'),'{ broken');
});
test('shared cross-agent recall cannot reassign or poison the calling agent session',async t=>{
  const {manager,service,dir}=await fixture(t);const id=await add(service,'foreign evidence');
  const shared=new MemoryService(manager,{agent:'another',workspaceId:dir,shared:true});
  const before=service.event(id).session_id;
  assert.equal((await shared.recall(id)).text,'foreign evidence');
  await assert.rejects(()=>shared.recall(id,{restore:true,sessionId:'target'}),/Cross-agent shared recall/);
  const saved=await shared.capture({sessionId:'target',toolCallId:'mine',toolName:'Read',input:'file',result:'local evidence'});
  assert.equal(saved.archived,true,saved.error ?? 'capture failed');assert.equal(service.event(id).session_id,before);
  assert.equal(manager.db.getCurrentTurn(sessionKey(shared.scope,'target')),1);
});

test('blob integrity is checked on raw bytes before UTF-8 replacement decoding',async t=>{
  const {dir}=await fixture(t);const blobs=new BlobStore(path.join(dir,'replacement-attack'),0);
  const ref=blobs.put('\uFFFD');fs.writeFileSync(blobs.blobFilePath(ref),Buffer.from([0xff]));
  await assert.rejects(async()=>blobs.get(ref),/integrity/);
});
