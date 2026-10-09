import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {defaultConfig,saveConfig,loadConfig,configRevision,updateConfig} from '../src/config.js';

test('configuration writers in independent processes reread under lock and preserve other fields',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cmm-config-lock-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const cfg=defaultConfig(dir);cfg.providers.retention=[{kind:'fake',name:'synthetic',model:'fixture',apiKey:'KEEP_PRIVATE'}];saveConfig(cfg);
  const moduleUrl=new URL('../src/config.js',import.meta.url).href;
  const patches=[{integration:{captureOnly:true}},{integration:{historyCooldownTurns:9}},{logging:{level:'warn'}}];
  const results=await Promise.all(patches.map(patch=>new Promise<number|null>((resolve,reject)=>{
    const source=`import {updateConfig} from ${JSON.stringify(moduleUrl)}; await updateConfig(process.argv[1],JSON.parse(process.argv[2]));`;
    const child=spawn(process.execPath,['--input-type=module','-e',source,dir,JSON.stringify(patch)],{stdio:['ignore','ignore','pipe']});
    let stderr='';child.stderr.on('data',b=>stderr+=b);child.on('error',reject);child.on('close',code=>code===0?resolve(code):reject(new Error(stderr)));
  })));
  assert.deepEqual(results,[0,0,0]);const after=loadConfig(dir);
  assert.equal(after.integration.captureOnly,true);assert.equal(after.integration.historyCooldownTurns,9);assert.equal(after.logging.level,'warn');assert.equal(after.providers.retention[0].apiKey,'KEEP_PRIVATE');
  const revision=configRevision(dir);
  const racing=await Promise.allSettled([updateConfig(dir,{strategy:'aggressive'},revision),updateConfig(dir,{strategy:'conservative'},revision)]);
  assert.equal(racing.filter(r=>r.status==='fulfilled').length,1);assert.equal(racing.filter(r=>r.status==='rejected').length,1);
  const bytes=fs.readFileSync(path.join(dir,'config.json'));
  await assert.rejects(updateConfig(dir,{integration:{contextWindow:1}},configRevision(dir)));
  assert.deepEqual(fs.readFileSync(path.join(dir,'config.json')),bytes);
  assert.equal(fs.existsSync(path.join(dir,'config.write.lock')),false);
  await updateConfig(dir,current=>{
    current.integration.captureOnly=false;
    return current as unknown as Record<string,unknown>;
  });
  assert.equal(loadConfig(dir).integration.captureOnly,false);
});
