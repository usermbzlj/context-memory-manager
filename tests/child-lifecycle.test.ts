import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { observeChild } from '../src/util/child-lifecycle.js';

const fast={graceMs:100,forceMs:200,deadlineMs:2000};

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
