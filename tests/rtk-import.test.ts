import {test, type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {gzipSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {MemoryService} from '../src/runtime/memory.js';
import {readRtkEvidence,importRtkEvidence} from '../src/integrations/rtk.js';
import {sha256} from '../src/storage/blob-store.js';
import {makeManager,cleanup} from './util.js';

const cli=fileURLToPath(new URL('../src/cli.js',import.meta.url));
async function fixture(t:TestContext) {
  const {manager,dir}=await makeManager();t.after(()=>cleanup(dir,manager));
  const file=path.join(dir,'rtk-recall.db'),db=new DatabaseSync(file);
  // Pinned v0.50.0 schema contract, not a claim of running RTK's binary.
  db.exec(`CREATE TABLE recall(hash TEXT PRIMARY KEY,command TEXT,cwd TEXT,exit_code INTEGER,
    created_at INTEGER,total_lines INTEGER,shown_upto INTEGER,byte_size INTEGER,truncated INTEGER,codec TEXT,blob BLOB,recalled INTEGER DEFAULT 0)`);
  db.close();
  return {manager,dir,file,service:new MemoryService(manager,{agent:'test',workspaceId:dir})};
}
function insert(file:string,cwd:string,output:Buffer|string,extra:Record<string,unknown>={}) {
  const bytes=Buffer.from(output);const command='test-filter';const hash=sha256(Buffer.concat([Buffer.from(command),Buffer.from([0]),bytes])).slice(0,12);
  const row={hash,command,cwd,exit_code:0,created_at:1790000000,total_lines:bytes.length ? bytes.reduce((n,b)=>n+(b===10?1:0),0)+(bytes.at(-1)===10?0:1):0,
    shown_upto:1,byte_size:bytes.length,truncated:0,codec:'gzip',blob:gzipSync(bytes),...extra};
  const db=new DatabaseSync(file);try {db.prepare('INSERT INTO recall(hash,command,cwd,exit_code,created_at,total_lines,shown_upto,byte_size,truncated,codec,blob) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(row.hash,row.command,row.cwd,row.exit_code,row.created_at,row.total_lines,row.shown_upto,row.byte_size,row.truncated,row.codec,row.blob);}finally{db.close();}
  return {hash:row.hash as string,row};
}

test('RTK full gzip payload is independently hash-checked, copied, searchable, and source DB stays unchanged',async t=>{
  const {service,dir,file}=await fixture(t);const original='\uFEFFheader\r\n\u4f60\u597d\uD83D\uDE80\0\r\n'+'full evidence\n'.repeat(3000);
  const {hash}=insert(file,dir,original);const before=sha256(fs.readFileSync(file));
  const saved=await importRtkEvidence(service,{database:file,hash,workspace:dir});assert.equal(saved.archived,true);
  assert.equal(saved.source.sourceHashValidated,true);assert.equal(saved.source.provenance.completeness,'complete');
  assert.equal((await service.manager.archive.fetchOriginal(saved.eventId!)).result,original);
  assert.equal(sha256(fs.readFileSync(file)),before);assert.ok(service.search('evidence').results.some(r=>r.eventId===saved.eventId));
  const again=await importRtkEvidence(service,{database:file,hash,workspace:dir});assert.equal(again.eventId,saved.eventId);
});
test('RTK truncated hidden tail is partial and never validated against an unavailable full hash',async t=>{
  const {service,dir,file}=await fixture(t);const partial='hidden-tail\n';const {hash}=insert(file,dir,partial,{hash:'aaaaaaaaaaaa',truncated:1,byte_size:1000000});
  const saved=await importRtkEvidence(service,{database:file,hash,workspace:dir});assert.equal(saved.archived,true);
  assert.equal(saved.source.sourceHashValidated,false);assert.equal(saved.source.provenance.completeness,'partial');
  const recalled=await service.recall(saved.eventId!);assert.equal(recalled.text,partial);assert.match(recalled.notice,/portion/);
  service.manager.db.updateToolEvent(saved.eventId!,{state:'capsule'});
  assert.equal((await service.project(saved.eventId!,partial,'history',`rtk-import:${hash}`)).reason,'incomplete-source');
});
test('RTK corrupted full-source hash is refused instead of trusted because the filename looks hashed',async t=>{
  const {dir,file}=await fixture(t);const {hash}=insert(file,dir,'bad',{hash:'012345abcdef'});
  assert.throws(()=>readRtkEvidence({database:file,hash,workspace:dir}),/hash\/length mismatch/);
});
test('RTK workspace mismatch and missing cwd are refused before data can cross project scopes',async t=>{
  const {dir,file}=await fixture(t);const a=insert(file,dir+'/different','a');
  assert.throws(()=>readRtkEvidence({database:file,hash:a.hash,workspace:dir+'/another'}),/cross-project/);
  const b=insert(file,dir,'b',{cwd:null});assert.throws(()=>readRtkEvidence({database:file,hash:b.hash,workspace:dir}),/cross-project/);
});
test('RTK reference input cannot inject SQL or execute a shell command',async t=>{
  const {dir,file}=await fixture(t);const marker=path.join(dir,'must-not-exist');
  assert.throws(()=>readRtkEvidence({database:file,hash:`$(touch ${marker})`,workspace:dir}),/12 lowercase/);
  assert.throws(()=>readRtkEvidence({database:file,hash:"'; DELETE FROM recall;--",workspace:dir}),/12 lowercase/);
  assert.equal(fs.existsSync(marker),false);
});
test('RTK raw codec works and unknown codec or invalid UTF-8 fails clearly',async t=>{
  const {dir,file}=await fixture(t);const a=insert(file,dir,'raw\n',{codec:'raw',blob:Buffer.from('raw\n')});
  assert.equal(readRtkEvidence({database:file,hash:a.hash,workspace:dir}).result,'raw\n');
  const b=insert(file,dir,'unknown',{codec:'zstd'});assert.throws(()=>readRtkEvidence({database:file,hash:b.hash,workspace:dir}),/codec/);
  const c=insert(file,dir,Buffer.from([0xff]));assert.throws(()=>readRtkEvidence({database:file,hash:c.hash,workspace:dir}),/encoded|encoding|UTF/i);
});
test('RTK malformed gzip, impossible length, and schema views are refused',async t=>{
  const {dir,file}=await fixture(t);const a=insert(file,dir,'payload',{blob:Buffer.from('not gzip')});
  assert.throws(()=>readRtkEvidence({database:file,hash:a.hash,workspace:dir}));
  const b=insert(file,dir,'long',{byte_size:1});assert.throws(()=>readRtkEvidence({database:file,hash:b.hash,workspace:dir}),/size/);
  const view=path.join(dir,'view.db'),db=new DatabaseSync(view);db.exec('CREATE VIEW recall AS SELECT 1 AS hash');db.close();
  assert.throws(()=>readRtkEvidence({database:view,hash:'012345abcdef',workspace:dir}),/ordinary table/);
});
test('RTK expired references do not cause source database creation',async t=>{
  const {dir,file}=await fixture(t);assert.throws(()=>readRtkEvidence({database:file,hash:'012345abcdef',workspace:dir}),/not found/);
  const absent=path.join(dir,'missing.db');assert.throws(()=>readRtkEvidence({database:absent,hash:'012345abcdef',workspace:dir}));assert.equal(fs.existsSync(absent),false);
});
test('explicit RTK opt-in automatically copies a hint but preserves original event provenance and output',async t=>{
  const {service,manager,dir,file}=await fixture(t);const {hash}=insert(file,dir,'original recovered source\n');
  manager.config.integration.rtkDatabasePath=file;
  const filtered=`short result\n[full output: rtk recall ${hash}]`;
  const saved=await service.capture({sessionId:'host',toolCallId:'call',toolName:'Bash',input:'rtk test command',result:filtered});
  const recall=await service.recall(saved.eventId!);assert.equal(recall.text,filtered);assert.equal(recall.provenance.origin,'upstream-filtered');
  const links=service.related(saved.eventId!);assert.equal(links.length,1);assert.equal(links[0].relation,'unverified-upstream-hint');
  assert.equal((await service.recall(links[0].eventId)).text,'original recovered source\n');
  assert.equal(service.explain(saved.eventId!).provenance.completeness,'unknown');
});
test('unavailable RTK copy fails open after the observed host output is safely archived',async t=>{
  const {service,manager,dir}=await fixture(t);manager.config.integration.rtkDatabasePath=path.join(dir,'missing.db');
  const saved=await service.capture({sessionId:'s',toolName:'Bash',input:'rtk git status',result:'[full output: rtk recall 012345abcdef]'});
  assert.equal(saved.archived,true);assert.equal(service.related(saved.eventId!).length,0);
  assert.ok((service.status().health as {mode:string;last_error:string}[]).some(r=>r.mode==='rtk:import' && r.last_error));
});
test('CLI RTK dry run does not create destination storage; actual import exposes exact recalled data',async t=>{
  const {dir,file}=await fixture(t);const {hash}=insert(file,dir,'CLI importer evidence');const dest=path.join(dir,'destination');
  const common=['import-rtk','--database',file,'--hash',hash,'--workspace',dir,'--storage',dest,'--agent','test'];
  const preview=spawnSync(process.execPath,[cli,...common,'--dry-run'],{encoding:'utf8',timeout:10000});assert.equal(preview.status,0,preview.stderr);
  assert.equal(JSON.parse(preview.stdout).dryRun,true);assert.equal(fs.existsSync(dest),false);
  const actual=spawnSync(process.execPath,[cli,...common],{encoding:'utf8',timeout:10000});assert.equal(actual.status,0,actual.stderr);const eventId=JSON.parse(actual.stdout).eventId;
  const recall=spawnSync(process.execPath,[cli,'recall',eventId,'--workspace',dir,'--storage',dest,'--agent','test'],{encoding:'utf8',timeout:10000});
  assert.equal(recall.status,0,recall.stderr);assert.equal(JSON.parse(recall.stdout).text,'CLI importer evidence');
});
