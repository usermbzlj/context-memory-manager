import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync,type ChildProcess} from 'node:child_process';
import {defaultConfig,saveConfig,loadConfig,updateConfig,validateConfig,createConfigIfAbsent} from '../src/config.js';
import {removeDir} from './remove-dir.js';

function fixture(t:TestContext) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cmm-config-recover-'));t.after(()=>removeDir(dir));
  saveConfig(defaultConfig(dir));
  return {dir,file:path.join(dir,'config.json'),lock:path.join(dir,'config.write.lock')};
}
const holder=(pid:number,hostname=os.hostname())=>JSON.stringify({pid,hostname,createdAt:new Date().toISOString()});
function deadPid() {
  const r=spawnSync(process.execPath,['-e','process.stdout.write(String(process.pid))'],{encoding:'utf8'});
  return Number(r.stdout);
}
function sleeper(t:TestContext):ChildProcess {
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  t.after(()=>{child.kill();});
  return child;
}

test('a writer lock left by a dead process on this host is recovered and the save succeeds',async t=>{
  const {dir,lock}=fixture(t);
  fs.writeFileSync(lock,holder(deadPid()));
  const next=await updateConfig(dir,{integration:{captureOnly:true}});
  assert.equal(next.integration.captureOnly,true);assert.equal(loadConfig(dir).integration.captureOnly,true);
  assert.equal(fs.existsSync(lock),false);
  assert.deepEqual(fs.readdirSync(dir).filter(n=>n.includes('.stale.')),[]);
});

test('a writer lock held by a live process is refused with a message naming the lock, leaving config bytes unchanged',async t=>{
  const {dir,file,lock}=fixture(t);const child=sleeper(t);assert.ok(child.pid);
  const before=fs.readFileSync(file);
  for(const content of [holder(child.pid!),holder(process.pid),'',String(process.pid),holder(deadPid(),'some-other-host'),'{not json']) {
    fs.writeFileSync(lock,content);
    await assert.rejects(updateConfig(dir,{integration:{captureOnly:true}},undefined,200),(error:Error)=>{
      assert.ok(error.message.includes(lock),error.message);assert.match(error.message,/only if no Context Memory Manager process is running/);return true;
    },`lock content ${content}`);
    assert.deepEqual(fs.readFileSync(file),before);
    assert.equal(fs.readFileSync(lock,'utf8'),content,'a possibly active lock is never stolen');
  }
});

test('the writer lock is released after both success and failure',async t=>{
  const {dir,lock}=fixture(t);
  await assert.rejects(updateConfig(dir,{integration:{contextWindow:1}}));
  assert.equal(fs.existsSync(lock),false);
  await updateConfig(dir,{strategy:'aggressive'});
  assert.equal(fs.existsSync(lock),false);
});

test('an invalid first patch on an absent configuration writes nothing',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cmm-config-absent-'));t.after(()=>removeDir(dir));
  await assert.rejects(updateConfig(dir,{integration:{contextWindow:1}}));
  assert.equal(fs.existsSync(path.join(dir,'config.json')),false);assert.equal(fs.existsSync(path.join(dir,'config.write.lock')),false);
  await updateConfig(dir,{strategy:'aggressive'});
  assert.equal(loadConfig(dir).strategy,'aggressive');
});

test('a configuration beginning with a UTF-8 byte order mark is readable and is not rewritten by reading',t=>{
  const {dir,file}=fixture(t);
  const bytes=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),Buffer.from(JSON.stringify({...defaultConfig(dir),strategy:'aggressive'},null,2))]);
  fs.writeFileSync(file,bytes);
  assert.equal(loadConfig(dir).strategy,'aggressive');
  assert.deepEqual(fs.readFileSync(file),bytes);
});

test('new settings require https for credentials unless the host is loopback; keyless providers may use http',()=>{
  const cfg=(provider:Record<string,unknown>)=>{const c=defaultConfig(os.tmpdir());c.providers.retention=[{kind:'openai-compatible',name:'p',model:'m',...provider} as any];return c;};
  for(const bad of [{apiKey:'k',baseUrl:'http://10.0.0.5/v1'},{apiKeyEnv:'SOME_KEY',baseUrl:'http://example.test/v1'},{apiKey:'k',baseUrl:'http://127.0.0.1.example.test/v1'}]) {
    assert.throws(()=>validateConfig(cfg(bad),null),/requires an https baseUrl/,JSON.stringify(bad));
    assert.doesNotThrow(()=>validateConfig(cfg(bad)),'loading an older file stays possible');
  }
  for(const ok of [{apiKey:'k',baseUrl:'http://localhost:1234/v1'},{apiKey:'k',baseUrl:'http://127.0.0.1:1/v1'},{apiKey:'k',baseUrl:'http://127.9.9.9/v1'},
    {apiKey:'k',baseUrl:'http://[::1]:8080/v1'},{apiKeyEnv:'SOME_KEY',baseUrl:'https://api.example.test/v1'},{baseUrl:'http://10.0.0.5/v1'}])
    assert.doesNotThrow(()=>validateConfig(cfg(ok),null),JSON.stringify(ok));
});

test('an existing cleartext credential configuration still loads, so hooks keep capturing',t=>{
  const {dir,file}=fixture(t);
  const c=defaultConfig(dir);c.providers.capsule=[{kind:'openai-compatible',name:'lan',model:'m',apiKey:'k',baseUrl:'http://10.0.0.5/v1'}];
  fs.writeFileSync(file,JSON.stringify(c,null,2));
  assert.equal(loadConfig(dir).providers.capsule[0].baseUrl,'http://10.0.0.5/v1');
});

test('a legacy cleartext credential entry never blocks unrelated saves; only a new or changed entry is refused',async t=>{
  const {dir,file}=fixture(t);
  const c=defaultConfig(dir);c.providers.capsule=[{kind:'openai-compatible',name:'lan',model:'m',apiKey:'k',baseUrl:'http://10.0.0.5/v1'}];
  fs.writeFileSync(file,JSON.stringify(c,null,2));
  const legacy=()=>loadConfig(dir).providers.capsule[0];
  const edit=(change:Record<string,unknown>)=>updateConfig(dir,cur=>({providers:{...cur.providers,capsule:[{...cur.providers.capsule[0],...change}]}}));
  const next=await updateConfig(dir,{strategy:'aggressive'});
  assert.equal(next.strategy,'aggressive');assert.deepEqual(legacy(),c.providers.capsule[0]);
  await updateConfig(dir,{integration:{captureOnly:true}});assert.deepEqual(legacy(),c.providers.capsule[0]);
  const before=fs.readFileSync(file);
  await assert.rejects(edit({model:'m2'}),/requires an https baseUrl/);
  await assert.rejects(edit({baseUrl:'http://10.0.0.6/v1'}),/requires an https baseUrl/);
  await assert.rejects(updateConfig(dir,cur=>({providers:{...cur.providers,chain:[{...cur.providers.capsule[0]}]}})),/requires an https baseUrl/,'a new entry under another purpose is new');
  assert.deepEqual(fs.readFileSync(file),before);assert.equal(fs.existsSync(path.join(dir,'config.write.lock')),false);
  await edit({baseUrl:'https://lan.example.test/v1'});
  assert.equal(legacy().baseUrl,'https://lan.example.test/v1');assert.equal(legacy().apiKey,'k');
});

test('brand-new configuration files check every provider entry',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cmm-config-new-'));
  try {
    const c=defaultConfig(dir);c.providers.chain=[{kind:'openai-compatible',name:'p',model:'m',apiKeyEnv:'SOME_KEY',baseUrl:'http://10.0.0.5/v1'}];
    assert.throws(()=>createConfigIfAbsent(c),/requires an https baseUrl/);
    assert.equal(fs.existsSync(path.join(dir,'config.json')),false);
  } finally { removeDir(dir); }
});

test('releasing the writer lock never removes a lock that another writer now owns',async t=>{
  const {dir,lock}=fixture(t);
  const foreign=holder(process.pid+100000);
  const next=await updateConfig(dir,cur=>{fs.writeFileSync(lock,foreign);return {strategy:'aggressive'};});
  assert.equal(next.strategy,'aggressive');assert.equal(loadConfig(dir).strategy,'aggressive');
  assert.equal(fs.readFileSync(lock,'utf8'),foreign,'the foreign lock stays');
});

test('a guard file orphaned by a crashed reclaimer is cleaned up, while a fresh guard blocks reclaim',async t=>{
  const {dir,lock}=fixture(t);const guard=lock+'.reclaim';
  const dead=holder(deadPid());
  fs.writeFileSync(lock,dead);fs.writeFileSync(guard,'');
  await assert.rejects(updateConfig(dir,{strategy:'aggressive'},undefined,200),(error:Error)=>error.message.includes(lock));
  assert.equal(fs.readFileSync(lock,'utf8'),dead,'a fresh guard means someone is reclaiming right now');assert.equal(fs.existsSync(guard),true);
  const old=new Date(Date.now()-60_000);fs.utimesSync(guard,old,old);
  await updateConfig(dir,{strategy:'aggressive'});
  assert.equal(loadConfig(dir).strategy,'aggressive');assert.equal(fs.existsSync(lock),false);assert.equal(fs.existsSync(guard),false);
});

test('several writers reclaiming one dead holder each get the lock in turn and leave no lock or guard behind',async t=>{
  const {dir,lock}=fixture(t);
  fs.writeFileSync(lock,holder(deadPid()));
  const seen:string[]=[];
  await Promise.all(Array.from({length:6},(_,i)=>updateConfig(dir,()=>{
    const content=fs.readFileSync(lock,'utf8');assert.equal(JSON.parse(content).pid,process.pid,'the lock is ours while we compute');
    seen.push(content);return {integration:{contextWindow:2048+i}};
  },undefined,20000)));
  assert.equal(seen.length,6);assert.equal(fs.existsSync(lock),false);assert.equal(fs.existsSync(lock+'.reclaim'),false);
});
