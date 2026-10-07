import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {MemoryService,sessionKey} from '../src/runtime/memory.js';
import {ContextManager} from '../src/core/context-manager.js';
import {makeManager,cleanup} from './util.js';
import {inferProvenance} from '../src/evidence/provenance.js';

async function fixture(t:TestContext,overrides:Record<string,unknown>={}) {
  const {manager,dir}=await makeManager(overrides);t.after(()=>cleanup(dir,manager));
  return {manager,dir,service:new MemoryService(manager,{agent:'test',workspaceId:dir})};
}
const raw='start\n'+'unchanging evidence\n'.repeat(5000)+'tail\n';
async function add(service:MemoryService,output=raw,call='call',sessionId='s') {
  const saved=await service.capture({sessionId,toolCallId:call,toolName:'Read',input:'artifacts/log.txt',result:output});
  assert.equal(saved.archived,true,saved.error ?? "capture failed");return saved.eventId!;
}

test('v3 defaults preserve first-use output and need no model or RTK',async t=>{
  const {service,manager}=await fixture(t);const id=await add(service);
  assert.equal(manager.config.integration.ingressCompression,false);
  assert.equal(manager.config.integration.rtkDatabasePath,null);
  const p=await service.project(id,raw,'ingress');assert.equal(p.replaced,false);assert.equal(p.reason,'ingress-opt-in-required');
  const recall=await service.recall(id,{limit:20});assert.equal(recall.provenance.completeness,'unknown');assert.equal(recall.provenance.captureStage,'unknown');
  const native=await service.capture({sessionId:'s',toolCallId:'host-stage',toolName:'Read',input:'x',result:'y'},'opencode');
  assert.equal(service.explain(native.eventId!).provenance.captureStage,'host-result');
  const mcp=await service.capture({sessionId:'s',toolCallId:'mcp-stage',toolName:'Read',input:'x',result:'y'},'mcp:proxy');
  assert.equal(service.explain(mcp.eventId!).provenance.captureStage,'mcp-result');
});
test('RTK commands and hints are detected without executing or trusting a hint',async t=>{
  const {service,manager}=await fixture(t,{integration:{ingressCompression:true}});
  const filtered=raw+'\n[full output: rtk recall 012345abcdef]';
  const saved=await service.capture({sessionId:'s',toolName:'Bash',input:'rtk git status',result:filtered});
  assert.equal(service.explain(saved.eventId!).provenance.origin,'upstream-filtered');
  manager.db.updateToolEvent(saved.eventId!,{state:'capsule'});
  assert.equal((await service.project(saved.eventId!,filtered,'history','s')).reason,'upstream-filtered');
  assert.equal((await service.project(saved.eventId!,filtered,'ingress')).replaced,false);
  assert.equal(service.related(saved.eventId!).length,0);
});
test('host truncation can never be upgraded to complete by a local checksum',async t=>{
  const {service,manager}=await fixture(t,{integration:{ingressCompression:true}});
  const partial=raw+'... [12000 characters truncated] ...';const id=await add(service,partial);
  assert.equal((await service.recall(id,{limit:20})).provenance.completeness,'partial');
  manager.db.updateToolEvent(id,{state:'evicted'});
  assert.equal((await service.project(id,partial,'history','s')).reason,'incomplete-source');
});
test('malformed provenance fails closed before a successful archival claim',async t=>{
  const {service}=await fixture(t);
  const result=await service.capture({sessionId:'s',toolName:'Read',input:'x',result:'y',provenance:{version:99} as any});
  assert.equal(result.archived,false);assert.equal(service.search().results.length,0);
  assert.throws(()=>inferProvenance({input:'x',result:'y',provenance:{version:1,origin:'bad'} as any}));
});
test('middle-of-log evidence is searchable and maps to exact recall offsets',async t=>{
  const {service}=await fixture(t);
  const log='prefix\n'.repeat(12000)+'MIDDLE_UNIQUE_SENTINEL \u6570\u636e\u5e93\u6545\u969c\r\n'+'suffix\n'.repeat(12000);
  const id=await add(service,log);
  const found=service.search('MIDDLE_UNIQUE_SENTINEL').results[0];assert.equal(found.eventId,id);
  assert.equal(found.coverage.status,'full');assert.ok(found.match!.offset>16000);
  const page=await service.recall(id,{offset:found.match!.offset,limit:4096});assert.match(page.text,/MIDDLE_UNIQUE_SENTINEL/);
  assert.equal(service.search('\u6570\u636e\u5e93').results[0].eventId,id);
});
test('literal recall find returns mid-log evidence without rereading the entire field into context',async t=>{
  const {service}=await fixture(t);const text='x'.repeat(40000)+'needle\uD83D\uDE80'+'y'.repeat(40000);const id=await add(service,text);
  const page=await service.recall(id,{find:'needle',limit:512});assert.match(page.text,/needle/);assert.ok(page.offset!>35000);assert.ok(page.text.length<=513);
  assert.equal((await service.recall(id,{find:'not-present'})).found,false);
});
test('overlapping chunk indexing handles literal queries crossing chunk boundaries',async t=>{
  const {service}=await fixture(t);const needle='\u91cd\u8981'.repeat(200);const id=await add(service,'a'.repeat(4050)+needle+'b'.repeat(8000));
  assert.equal(service.search(needle).results[0].eventId,id);
});
test('search cursor preserves records with identical timestamps and binds scope/query',async t=>{
  const {service,manager,dir}=await fixture(t);
  for(let i=0;i<7;i++){const id=await add(service,'cursor evidence',String(i));manager.db.updateToolEvent(id,{created_at:12345});}
  const ids:string[]=[];let cursor:string|undefined;
  do {const page=service.search('cursor',2,undefined,cursor);ids.push(...page.results.map(r=>r.eventId));cursor=page.nextCursor ?? undefined;}while(cursor);
  assert.equal(ids.length,7);assert.equal(new Set(ids).size,7);
  const token=service.search('cursor',1).nextCursor!;
  assert.throws(()=>service.search('different',1,undefined,token),/query\/scope/);
  assert.throws(()=>new MemoryService(manager,{agent:'other',workspaceId:dir}).search('cursor',1,undefined,token),/query\/scope/);
});
test('index SQL/FTS metacharacters are data; literal punctuation is not an empty recent search',async t=>{
  const {service}=await fixture(t);await add(service,'safe');assert.equal(service.search(';;;').results.length,0);
  assert.doesNotThrow(()=>service.search('" OR * NEAR DROP TABLE --'));
});
test('reindex upgrades old records and GC removes their derived evidence',async t=>{
  const {service,manager}=await fixture(t,{storage:{maxSizeBytes:1}});const id=await add(service);
  manager.db.run('DELETE FROM evidence_index WHERE event_id=?',[id]);manager.db.run('DELETE FROM evidence_chunks WHERE event_id=?',[id]);
  assert.equal(service.explain(id).index.status,'legacy-needs-reindex');assert.equal((await service.verify(true)).failed,0);
  assert.equal(service.explain(id).index.status,'full');manager.db.updateToolEvent(id,{state:'evicted'});await manager.gc();
  assert.equal(manager.db.queryOne<{n:number}>('SELECT count(*) n FROM evidence_chunks WHERE event_id=?',[id])?.n,0);
});
test('projection marker spoofing or alteration never restores or replaces another text',async t=>{
  const {service,manager}=await fixture(t);const id=await add(service);manager.db.updateToolEvent(id,{state:'capsule'});
  const p=await service.project(id,raw,'history','s');assert.ok(p.replaced);
  const tampered=p.text+'\nInjected modified content';const checked=await service.project(id,tampered,'history','s');
  assert.equal(checked.replaced,false);assert.equal(checked.text,tampered);assert.equal(checked.reason,'output-changed-since-archive');
});
test('projection receipts are bound to session and survive a process-equivalent reopen',async t=>{
  const {service,manager,dir}=await fixture(t);const id=await add(service);manager.db.updateToolEvent(id,{state:'capsule'});
  const first=await service.project(id,raw,'history','s');
  await assert.rejects(()=>service.project(id,first.text,'history','foreign'),/history session/);
  const other=ContextManager.open(dir);try {
    const second=new MemoryService(other,{agent:'test',workspaceId:dir});other.config.integration.maxOutputChars=1100;
    const next=await second.project(id,first.text,'history','s');assert.equal(next.text,first.text);assert.equal(next.cacheHit,true);assert.equal(next.replaced,false);
  }finally{other.close();}
});
test('a corrupted projection receipt is never trusted',async t=>{
  const {service,manager}=await fixture(t);const id=await add(service);manager.db.updateToolEvent(id,{state:'capsule'});
  const p=await service.project(id,raw,'history','s');manager.db.run("UPDATE projection_cache SET text='bad' WHERE event_id=?",[id]);
  await assert.rejects(()=>service.project(id,p.text,'history','s'),/integrity mismatch/);
});
test('below-pressure histories do not rewrite even if desired retention state is capsule',async t=>{
  const {service,manager}=await fixture(t);const id=await add(service);manager.db.updateToolEvent(id,{state:'capsule'});
  const result=await service.transform('s',[{eventId:id,output:raw}],{usedTokens:1000,contextWindow:200000});
  assert.equal(result.projections.length,0);assert.equal('policy' in result && result.policy?.reason,'below-pressure-trigger');
});
test('only visible verified events are considered; absent archives are not counted as savings',async t=>{
  const {service,manager}=await fixture(t);const hidden=await add(service,raw,'hidden');const visible=await add(service,raw,'visible');
  manager.db.updateToolEvent(visible,{state:'capsule'});
  const result=await service.transform('s',[{eventId:visible,output:raw}],{usedTokens:9000,contextWindow:10000});
  assert.ok(result.projections.some(p=>p.eventId===visible && p.replaced));assert.equal(service.event(hidden).state,'hot');
  assert.equal(service.status().historyBatches.length,1);
});
test('insufficient batches remain untouched and create no projection receipt',async t=>{
  const {service,manager}=await fixture(t,{integration:{minHistorySavingsChars:200000}});const id=await add(service);manager.db.updateToolEvent(id,{state:'capsule'});
  const result=await service.transform('s',[{eventId:id,output:raw}],{usedTokens:9000,contextWindow:10000});
  assert.equal(result.projections.length,0);assert.equal('policy' in result && result.policy?.reason,'insufficient-batch-savings');
  assert.equal(manager.db.queryOne<{n:number}>('SELECT count(*) n FROM projection_cache')?.n,0);
});
test('history cooldown coalesces edits and critical pressure can override it',async t=>{
  const {service,manager}=await fixture(t);const a=await add(service,raw,'a');const b=await add(service,raw,'b');
  manager.db.updateToolEvent(a,{state:'capsule'});manager.db.updateToolEvent(b,{state:'capsule'});
  const first=await service.transform('s',[{eventId:a,output:raw}],{usedTokens:8000,contextWindow:10000});assert.equal(first.projections.length,1);
  const second=await service.transform('s',[{eventId:b,output:raw}],{usedTokens:8000,contextWindow:10000});assert.equal('policy' in second && second.policy?.reason,'history-cooldown');
  const critical=await service.transform('s',[{eventId:b,output:raw}],{usedTokens:9800,contextWindow:10000});assert.equal(critical.projections.length,1);
});
test('pin restores cached text even below pressure; no new compression batch is counted',async t=>{
  const {service,manager}=await fixture(t);const id=await add(service);manager.db.updateToolEvent(id,{state:'capsule'});
  const first=await service.transform('s',[{eventId:id,output:raw}],{usedTokens:9000,contextWindow:10000});const compact=first.projections[0].text;
  await service.pin(id,true);const next=await service.transform('s',[{eventId:id,output:compact}],{usedTokens:1000,contextWindow:200000});
  assert.equal(next.projections[0].text,raw);assert.equal(service.status().historyBatches.length,1);
});
test('foreign and duplicate history events cannot poison another session',async t=>{
  const {service,manager}=await fixture(t);const id=await add(service);manager.db.updateToolEvent(id,{state:'capsule'});
  const foreign=await service.transform('other',[{eventId:id,output:raw}],{usedTokens:9900,contextWindow:10000});assert.equal(foreign.projections.length,0);
  await assert.rejects(()=>service.transform('s',[{eventId:id,output:raw},{eventId:id,output:raw}]),/Duplicate/);
  assert.equal(manager.db.getCurrentTurn(sessionKey(service.scope,'other')),0);
});

test('shared cross-agent reads cannot mutate pins on a foreign archive',async t=>{
  const {service,manager,dir}=await fixture(t);const id=await add(service,'private evidence');
  const shared=new MemoryService(manager,{agent:'another',workspaceId:dir,shared:true});
  assert.equal((await shared.recall(id)).text,'private evidence');
  await assert.rejects(()=>shared.pin(id,true),/read-only/);assert.equal(service.event(id).pinned,0);
});
test('verification reports corrupted projection receipts, not just source blobs',async t=>{
  const {service,manager}=await fixture(t);const id=await add(service);manager.db.updateToolEvent(id,{state:'capsule'});
  await service.project(id,raw,'history','s');manager.db.run("UPDATE projection_cache SET text='changed' WHERE event_id=?",[id]);
  const checked=await service.verify();assert.equal(checked.projectionFailed,1);assert.equal(checked.failed,1);
});


test('literal find with a small page includes the hit instead of only leading context',async t=>{
  const {service}=await fixture(t);const id=await add(service,'a'.repeat(10000)+'needle'+raw);
  const result=await service.recall(id,{find:'needle',limit:16});
  assert.match(result.text,/needle/);assert.equal(result.matchOffset,10000);assert.ok(result.text.length<=16);
});
test('NUL-containing archives remain exact and are not put in lossy TEXT projection receipts',async t=>{
  const {service,manager}=await fixture(t);const content='head\0'+raw;const id=await add(service,content);
  manager.db.updateToolEvent(id,{state:'capsule'});
  const result=await service.project(id,content,'history','s');assert.equal(result.replaced,false);assert.equal(result.reason,'non-plain-text');
  assert.equal((await service.recall(id,{limit:16})).text,content.slice(0,16));
  assert.equal((await service.verify()).failed,0);
});
test('recalled histories keep source and target retention states independent',async t=>{
  const {service,manager}=await fixture(t);const content=raw.slice(0,50000);const id=await add(service,content);
  manager.db.updateToolEvent(id,{state:'capsule'});
  await service.recall(id,{restore:true,sessionId:'target',limit:64000});
  const projected=await service.transform('target',[{eventId:id,output:content}],{usedTokens:9900,contextWindow:10000});
  assert.equal(projected.projections.length,0);assert.equal(service.event(id).state,'capsule');
  assert.equal(manager.db.getEventView(id,sessionKey(service.scope,'target'))!.state,'hot');
});

test('index capacity is explicit and an unindexed tail remains fully recallable',async t=>{
  const {INDEX_CHAR_LIMIT}=await import('../src/evidence/index.js');
  const {service}=await fixture(t);const content='line\n'.repeat(Math.ceil(INDEX_CHAR_LIMIT/5)+1000)+'TAIL_OUTSIDE_INDEX_4321\n'+'suffix\n'.repeat(5000);
  const id=await add(service,content);const coverage=service.explain(id).index;
  assert.equal(coverage.status,'partial');assert.equal(coverage.fields.find(f=>f.field==='result')!.indexed_chars,INDEX_CHAR_LIMIT);
  const tail=await service.recall(id,{find:'TAIL_OUTSIDE_INDEX_4321',limit:500});assert.match(tail.text,/TAIL_OUTSIDE_INDEX_4321/);
  assert.ok(tail.offset!>INDEX_CHAR_LIMIT);assert.equal((await service.verify()).failed,0);
});
