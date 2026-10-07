import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { observeChild } from '../src/util/child-lifecycle.js';

const cli=fileURLToPath(new URL('../src/cli.js',import.meta.url));
const fast={graceMs:100,forceMs:200,deadlineMs:2000};

async function completionWithin(lifecycle:ReturnType<typeof observeChild>) {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {return await Promise.race([lifecycle.closed,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Fixture completion timed out')),5000);})]);}
  finally {if(timer)clearTimeout(timer);}
}

async function outputUntil(child:ChildProcess,expected:string):Promise<void> {
  await new Promise<void>((resolve,reject)=>{
    let output='';
    const timer=setTimeout(()=>finish(new Error('Fixture did not become ready: '+output)),5000);
    const data=(chunk:Buffer)=>{output+=chunk.toString();if(output.includes(expected))finish();};
    const close=()=>finish(new Error('Fixture closed before becoming ready: '+output));
    const finish=(error?:Error)=>{clearTimeout(timer);child.stdout?.off('data',data);child.off('close',close);error?reject(error):resolve();};
    child.stdout!.on('data',data);child.once('close',close);
  });
}

test('child shutdown waits for stdio close, not exit, and escalates when TERM is ignored',async()=>{
  const fixture=new EventEmitter() as ChildProcess;
  const signals:NodeJS.Signals[]=[];
  fixture.kill=((signal:NodeJS.Signals)=>{signals.push(signal);if(signal==='SIGKILL')setTimeout(()=>fixture.emit('close',null,'SIGKILL'),20);return true;}) as ChildProcess['kill'];
  const lifecycle=observeChild(fixture);
  let completed=false;
  void lifecycle.closed.then(()=>{completed=true;});
  fixture.emit('exit',null,'SIGTERM');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(completed,false,'exit does not prove inherited stdio was closed');
  const stopping=lifecycle.shutdown({graceMs:20,forceMs:40,deadlineMs:500});
  assert.equal(lifecycle.shutdown(),stopping,'concurrent signals share one shutdown');
  const result=await stopping;
  assert.deepEqual(signals,['SIGTERM','SIGKILL']);assert.equal(result.signal,'SIGKILL');assert.equal(lifecycle.didClose,true);
});

test('an unconfirmed close reaches a deadline and leaves temporary files recoverable',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cmm-unclosed-'));
  const config=path.join(dir,'temporary-config.json');fs.writeFileSync(config,'{"privateFixture":true}');
  const fixture=new EventEmitter() as ChildProcess;
  const signals:NodeJS.Signals[]=[];
  let detached=false;fixture.unref=()=>{detached=true;};
  fixture.kill=((signal:NodeJS.Signals)=>{signals.push(signal);return false;}) as ChildProcess['kill'];
  const lifecycle=observeChild(fixture);
  try {
    await assert.rejects(()=>lifecycle.shutdown({graceMs:20,forceMs:40,deadlineMs:100}),/close was not observed/);
    assert.deepEqual(signals,['SIGTERM','SIGKILL']);assert.equal(lifecycle.didClose,false);
    assert.equal(detached,true,'an unkillable child cannot keep the reporting parent alive');
    if(lifecycle.didClose)fs.rmSync(dir,{recursive:true,force:true});
    assert.equal(fs.readFileSync(config,'utf8'),'{"privateFixture":true}');
    fixture.emit('close',1,null);
    assert.equal((await lifecycle.shutdown()).code,1,'a later actual close makes cleanup safe');
  } finally {fixture.emit('close',1,null);fs.rmSync(dir,{recursive:true,force:true});}
});

test('shutdown releases an actual SQLite child before deleting its storage',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cmm-child-sqlite-'));
  const database=path.join(dir,'held.db');
  const code='const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(process.argv[1]);db.exec("CREATE TABLE held(value TEXT)");process.stdin.resume();process.on("SIGTERM",()=>{});setInterval(()=>{},1000);process.stdout.write("ready\\n");';
  const child=spawn(process.execPath,['-e',code,database],{stdio:['pipe','pipe','ignore']});
  const lifecycle=observeChild(child);
  try {
    await outputUntil(child,'ready');
    const result=await lifecycle.shutdown(fast);
    assert.equal(lifecycle.didClose,true);assert.equal(child.stdout!.destroyed,true);
    if(process.platform!=='win32')assert.equal(result.signal,'SIGKILL','the actual fixture ignores TERM');
    fs.rmSync(dir,{recursive:true,force:true});assert.equal(fs.existsSync(dir),false);
  } finally {
    await lifecycle.shutdown();
    if(lifecycle.didClose)fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('a failed spawn still waits for close before declaring cleanup safe',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cmm-spawn-error-'));
  const child=spawn(path.join(dir,'does-not-exist'),[],{stdio:'pipe'});
  const lifecycle=observeChild(child);
  try {
    const result=await lifecycle.shutdown(fast);
    assert.equal((result.error as NodeJS.ErrnoException)?.code,'ENOENT');assert.equal(lifecycle.didClose,true);
  } finally {await lifecycle.shutdown();if(lifecycle.didClose)fs.rmSync(dir,{recursive:true,force:true});}
});

function launchFixture(mode:'natural'|'missing'|'signal') {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cmm-kimi-lifecycle-'));
  const bin=path.join(dir,'bin'),home=path.join(dir,'home');fs.mkdirSync(bin);fs.mkdirSync(home);
  const source=path.join(dir,'source.json'),marker=path.join(dir,'observed.json');
  const original='{"default_model":"local-fixture-no-credentials"}\n';fs.writeFileSync(source,original);
  if(mode!=='missing') {
    const script=path.join(bin,'fake-kimi.cjs');
    // This fixture only reads generated config paths and holds a local SQLite
    // handle. It has no agent SDK, network call or credentials.
    fs.writeFileSync(script,'const fs=require("node:fs");const {DatabaseSync}=require("node:sqlite");const args=process.argv.slice(2);const files=args.filter((v,i)=>i>0&&["--config-file","--mcp-config-file"].includes(args[i-1]));const db=new DatabaseSync(process.env.FIXTURE_DB);db.exec("CREATE TABLE held(value TEXT)");fs.writeFileSync(process.env.FIXTURE_MARKER,JSON.stringify({files,allExist:files.every(f=>fs.existsSync(f)),pid:process.pid}));'+(mode==='natural'?'setTimeout(()=>{fs.writeFileSync(process.env.FIXTURE_MARKER,JSON.stringify({files,allExist:files.every(f=>fs.existsSync(f))}));process.exit(7);},75);':'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);process.stdout.write("fake-kimi-ready\\n");'));
    if(process.platform==='win32')fs.writeFileSync(path.join(bin,'kimi.cmd'),'@"'+process.execPath+'" "'+script+'" %*\r\n');
    else {const executable=path.join(bin,'kimi');fs.writeFileSync(executable,'#!'+process.execPath+'\nrequire('+JSON.stringify(script)+');\n');fs.chmodSync(executable,0o700);}
  }
  const env={...process.env,PATH:bin,Path:bin,HOME:home,USERPROFILE:home,PATHEXT:'.EXE;.CMD;.BAT',FIXTURE_DB:path.join(dir,'held.db'),FIXTURE_MARKER:marker};
  const child=spawn(process.execPath,[cli,'launch','kimi','--workspace',dir,'--storage',path.join(dir,'storage'),'--config-file',source],{env,stdio:'pipe'});
  const lifecycle=observeChild(child);
  let stderr='';child.stderr!.on('data',chunk=>{stderr+=chunk.toString();});
  return {dir,source,original,marker,child,lifecycle,stderr:()=>stderr};
}

test('Kimi wrapper cleans temporary config after a fake host naturally closes its SQLite handle',async()=>{
  const fixture=launchFixture('natural');
  try {
    const result=await completionWithin(fixture.lifecycle);
    assert.equal(result.code,7,fixture.stderr());
    const observed=JSON.parse(fs.readFileSync(fixture.marker,'utf8'));
    assert.equal(observed.allExist,true,'temporary files remain available until the host exits');
    for(const file of observed.files)assert.equal(fs.existsSync(file),false,'temporary config removed after close');
    assert.equal(fs.readFileSync(fixture.source,'utf8'),fixture.original);
  } finally {await fixture.lifecycle.shutdown();if(fixture.lifecycle.didClose)fs.rmSync(fixture.dir,{recursive:true,force:true});}
});

test('Kimi wrapper removes temporary config after an isolated spawn error',async()=>{
  const fixture=launchFixture('missing');
  try {
    const result=await completionWithin(fixture.lifecycle);
    assert.equal(result.code,1);assert.match(fixture.stderr(),/ENOENT/);
    assert.equal(fs.readdirSync(fixture.dir).some(name=>name.startsWith('.cmm-launch-')),false);
    assert.equal(fs.readFileSync(fixture.source,'utf8'),fixture.original);
  } finally {await fixture.lifecycle.shutdown();if(fixture.lifecycle.didClose)fs.rmSync(fixture.dir,{recursive:true,force:true});}
});

test('Kimi wrapper signal waits for a fake host that ignores TERM before cleanup',{skip:process.platform==='win32'?'Windows kill terminates the wrapper without delivering a JS signal; utility escalation is covered independently':false},async()=>{
  const fixture=launchFixture('signal');
  try {
    await outputUntil(fixture.child,'fake-kimi-ready');
    const observed=JSON.parse(fs.readFileSync(fixture.marker,'utf8'));
    fixture.child.kill('SIGTERM');
    const result=await completionWithin(fixture.lifecycle);
    assert.equal(result.code,130,fixture.stderr());
    for(const file of observed.files)assert.equal(fs.existsSync(file),false);
    assert.throws(()=>process.kill(observed.pid,0),/ESRCH/,'the stubborn host has actually stopped');
  } finally {await fixture.lifecycle.shutdown();if(fixture.lifecycle.didClose)fs.rmSync(fixture.dir,{recursive:true,force:true});}
});
