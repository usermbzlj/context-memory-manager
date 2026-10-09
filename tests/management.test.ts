import {test,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {makeManager,cleanup} from './util.js';
import {MemoryService} from '../src/runtime/memory.js';
import {ManagementService} from '../src/management/service.js';
import {loadConfig,saveConfig,configRevision} from '../src/config.js';

async function fixture(t:TestContext) {
  const {manager,dir}=await makeManager();t.after(()=>cleanup(dir,manager));
  const memory=new MemoryService(manager,{agent:'codex',workspaceId:dir});
  const saved=await memory.capture({sessionId:'s',toolCallId:'one',toolName:'Read',input:'x',result:'\uFEFFhello\r\n\0🚀中文'});
  assert.equal(saved.archived,true);
  const service=new ManagementService(manager);
  const scopes=await service.execute('scopes',{}) as any;
  return {manager,dir,memory,service,scopeId:scopes.scopes[0].id,id:saved.eventId!};
}

test('management scope rejects foreign event, session, chain and capsule without exposing archive refs',async t=>{
  const {manager,dir,service,scopeId,id}=await fixture(t);
  const foreign=new MemoryService(manager,{agent:'other',workspaceId:dir});
  const saved=await foreign.capture({sessionId:'s',toolCallId:'foreign',toolName:'Read',input:'PRIVATE_INLINE',result:'FOREIGN_SECRET'});
  const row=manager.db.getToolEvent(saved.eventId!)!;
  for(const method of ['detail','content','download','pin'])await assert.rejects(service.execute(method,{scopeId,eventId:row.id,pinned:true}));
  await assert.rejects(service.execute('list',{scopeId,kind:'events',sessionId:row.session_id}));
  if(row.chain_id)await assert.rejects(service.execute('chain',{scopeId,chainId:row.chain_id}));
  manager.db.run('INSERT INTO capsules(id,source_event_ids_json,summary,facts_json,anchors_json,frozen,created_at,updated_at) VALUES(?,?,?,?,?,0,1,1)', ['foreign-capsule',JSON.stringify([id,row.id]),'FOREIGN_SECRET','[]','[]']);
  await assert.rejects(service.execute('capsule',{scopeId,capsuleId:'foreign-capsule'}));
  const list=await service.execute('list',{scopeId,kind:'events'}) as any;
  const serialized=JSON.stringify(list);
  assert.equal(list.items.length,1);assert.equal(serialized.includes('PRIVATE_INLINE'),false);assert.equal(serialized.includes('input_ref'),false);
  assert.equal((await service.execute('list',{scopeId,kind:'capsules'}) as any).items.some((c:any)=>c.id==='foreign-capsule'),false);
  await assert.rejects(service.execute('overview',{scopeId:'forged'}));
});

test('management pagination has a total order, signed expiry and binding to filters and scope',async t=>{
  const {manager,memory,service,scopeId,id}=await fixture(t);
  const ids=[id];
  for(let i=0;i<5;i++)ids.push((await memory.capture({sessionId:'s',toolCallId:'page-'+i,toolName:i%2?'Bash':'Read',input:'q',result:'PAGE_SENTINEL'})).eventId!);
  manager.db.run('UPDATE tool_events SET created_at=12345');
  let cursor:string|null=null;const found:string[]=[];
  do {const page=await service.execute('list',{scopeId,kind:'events',limit:2,cursor}) as any;found.push(...page.items.map((r:any)=>r.id));cursor=page.nextCursor;}while(cursor);
  assert.deepEqual(found,[...ids].sort().reverse());
  const first=await service.execute('list',{scopeId,kind:'events',limit:2}) as any;
  await assert.rejects(service.execute('list',{scopeId,kind:'events',limit:2,cursor:first.nextCursor+'x'}));
  await assert.rejects(service.execute('list',{scopeId,kind:'events',limit:2,tool:'Read',cursor:first.nextCursor}));
  const searched=await service.execute('list',{scopeId,kind:'events',query:'PAGE_SENTINEL',tool:'Bash',limit:1}) as any;
  assert.equal(searched.items[0].tool,'Bash');assert.ok(searched.nextCursor);
  const next=await service.execute('list',{scopeId,kind:'events',query:'PAGE_SENTINEL',tool:'Bash',limit:1,cursor:searched.nextCursor}) as any;
  assert.equal(next.items.length,1);assert.notEqual(next.items[0].id,searched.items[0].id);
});

test('management content and bounded download verify exact Unicode bytes without recall effects',async t=>{
  const {manager,service,scopeId,id}=await fixture(t);const before=manager.db.getToolEvent(id)!;
  const download=await service.execute('download',{scopeId,eventId:id,field:'result'}) as any;
  assert.equal(download.text,'\uFEFFhello\r\n\0🚀中文');
  assert.equal(createHash('sha256').update(download.text).digest('hex'),download.sha256);
  let offset=0, rebuilt='';
  for(;;){const page=await service.execute('content',{scopeId,eventId:id,offset,limit:4}) as any;rebuilt+=page.text;if(page.nextOffset===null)break;offset=page.nextOffset;}
  assert.equal(rebuilt,download.text);assert.deepEqual(manager.db.getToolEvent(id),before);
  assert.equal(manager.db.queryOne<any>('SELECT COUNT(*) AS n FROM recall_log')!.n,0);
  await assert.rejects(service.execute('content',{scopeId,eventId:id,limit:64001}));
  manager.db.updateToolEvent(id,{result_bytes:33*1024*1024});
  await assert.rejects(service.execute('download',{scopeId,eventId:id}));
  manager.db.updateToolEvent(id,{result_bytes:before.result_bytes,result_ref:'corrupt'});
  await assert.rejects(service.execute('download',{scopeId,eventId:id}));
});

test('settings credentials are write-only and preserved, replaced and deleted under CAS',async t=>{
  const {dir,service}=await fixture(t);const cfg=loadConfig(dir);
  cfg.providers.retention=[{kind:'fake',name:'synthetic',model:'test',apiKey:'PRIVATE_KEY',baseUrl:'http://127.0.0.1:1/v1?token=URL_SECRET#PRIVATE_HASH'}];saveConfig(cfg);
  let dto=await service.execute('settings',{}) as any;
  assert.equal(JSON.stringify(dto).includes('PRIVATE_KEY'),false);assert.equal(JSON.stringify(dto).includes('URL_SECRET'),false);
  const shown=dto.providers.retention[0];
  await service.execute('saveSettings',{expectedRevision:dto.revision,patch:{providers:{retention:[{kind:shown.kind,name:shown.name,model:shown.model,baseUrl:shown.baseUrl,keyAction:'keep'}]}}});
  assert.equal(loadConfig(dir).providers.retention[0].baseUrl,cfg.providers.retention[0].baseUrl,'Unchanged public metadata must not erase a legacy URL secret');
  dto=await service.execute('settings',{}) as any;
  await service.execute('saveSettings',{expectedRevision:dto.revision,patch:{strategy:'conservative'}});
  assert.equal(loadConfig(dir).providers.retention[0].apiKey,'PRIVATE_KEY');
  await assert.rejects(service.execute('saveSettings',{expectedRevision:dto.revision,patch:{strategy:'aggressive'}}));
  const entry={kind:'fake',name:'synthetic',model:'changed',baseUrl:'http://127.0.0.1:1/v1',keyAction:'keep'};
  dto=await service.execute('settings',{}) as any;
  await service.execute('saveSettings',{expectedRevision:dto.revision,patch:{providers:{retention:[entry]}}});
  assert.equal(loadConfig(dir).providers.retention[0].apiKey,'PRIVATE_KEY');
  assert.equal(loadConfig(dir).providers.retention[0].model,'changed');
  assert.equal(loadConfig(dir).providers.retention[0].baseUrl,cfg.providers.retention[0].baseUrl,'A model-only edit must keep the stored URL query and fragment');
  dto=await service.execute('settings',{}) as any;
  const before=fs.readFileSync(path.join(dir,'config.json'));
  for(const bad of [{providers:{retention:[{...entry,keyAction:'replace',newKey:'[REDACTED]'}]}},{providers:{retention:[{...entry,baseUrl:'https://example.invalid/?key=secret'}]}},{storage:{path:dir+'-foreign'}},{providers:{retention:[{...entry,apiKey:'secret'}]}}]){
    await assert.rejects(service.execute('saveSettings',{expectedRevision:dto.revision,patch:bad}));assert.deepEqual(fs.readFileSync(path.join(dir,'config.json')),before);
  }
  await service.execute('saveSettings',{expectedRevision:dto.revision,patch:{providers:{retention:[{...entry,keyAction:'replace',newKey:'NEW_PRIVATE_KEY'}]}}});
  assert.equal(loadConfig(dir).providers.retention[0].apiKey,'NEW_PRIVATE_KEY');
  await service.execute('saveSettings',{expectedRevision:configRevision(dir),patch:{providers:{retention:[{...entry,keyAction:'delete'}]}}});
  assert.equal(loadConfig(dir).providers.retention[0].apiKey,undefined);
  await service.execute('saveSettings',{expectedRevision:configRevision(dir),patch:{providers:{retention:[{...entry,apiKeyEnv:'CMM_SYNTHETIC_TEST_ENV',keyAction:'replace',newKey:'STORED_TEST_KEY'}]}}});
  await service.execute('saveSettings',{expectedRevision:configRevision(dir),patch:{providers:{retention:[{...entry,keyAction:'delete'}]}}});
  assert.equal(loadConfig(dir).providers.retention[0].apiKeyEnv,'CMM_SYNTHETIC_TEST_ENV');
  await service.execute('saveSettings',{expectedRevision:configRevision(dir),patch:{providers:{retention:[{...entry,apiKeyEnv:'',keyAction:'keep'}]}}});
  assert.equal((await service.execute('settings',{}) as any).providers.retention[0].keySource,'none');
});

test('provider tests require a saved revision, synthetic schema and redact failed provider output',async t=>{
  const {dir,manager,service}=await fixture(t);const cfg=loadConfig(dir);
  cfg.providers.retention=[{kind:'fake',name:'synthetic',model:'test'}];saveConfig(cfg);
  const params={role:'retention',name:'synthetic',expectedRevision:configRevision(dir)};
  assert.equal((await service.execute('testProvider',params) as any).ok,true);
  const calls=await service.execute('list',{scopeId:(await service.execute('scopes',{}) as any).scopes[0].id,kind:'providers'}) as any;
  assert.equal(calls.scope,'storage-global');assert.equal(calls.cost,'unpriced');assert.equal(calls.items.length,1);
  assert.equal(Object.hasOwn(calls.items[0],'error'),false);
  await assert.rejects(service.execute('testProvider',{...params,name:'unsaved',baseUrl:'https://example.invalid'}));
  await assert.rejects(service.execute('testProvider',{...params,expectedRevision:'0'.repeat(64)}));
  assert.equal(manager.db.queryOne<any>('SELECT COUNT(*) AS n FROM provider_calls')!.n,1);
});

test('native provider tests use state/questions and failures never return remote bodies or keys',async t=>{
  const {dir,service}=await fixture(t);let payload:any;let fail=false;
  const server=createServer((request,response)=>{
    let body='';request.on('data',chunk=>body+=chunk);request.on('end',()=>{
      payload=JSON.parse(body);
      response.writeHead(fail?401:200,{'content-type':'application/json'});
      response.end(fail?'REMOTE_SECRET_KEY_AND_BODY':JSON.stringify({answers:{event_0:{type:'noul',noul:0.5}},usage:{input_tokens:10,output_tokens:0}}));
    });
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())));
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const cfg=loadConfig(dir);cfg.retention.scorer='systemone';cfg.providers.retention=[{kind:'systemone',name:'native-test',model:'test',baseUrl:`http://127.0.0.1:${address.port}`,apiKey:'LOCAL_SYNTHETIC_KEY'}];saveConfig(cfg);
  const p={role:'retention',name:'native-test',expectedRevision:configRevision(dir)};
  const success=await service.execute('testProvider',p) as any;assert.equal(success.ok,true);
  assert.equal(payload.questions.event_0.type,'noul');assert.equal(payload.state.events[0].id,'event_0');assert.equal(payload.model,'test');
  fail=true;const failure=await service.execute('testProvider',p) as any;assert.equal(failure.ok,false);
  assert.equal(JSON.stringify(failure).includes('SECRET'),false);assert.equal(JSON.stringify(failure).includes('BODY'),false);
  assert.equal((await service.execute('list',{kind:'providers',status:'error'}) as any).items.length,1);
});

test('content enforces the absolute 64,000-unit boundary without splitting Unicode',async t=>{
  const {memory,service,scopeId}=await fixture(t);
  const text='x'.repeat(63999)+'🚀tail';
  const id=(await memory.capture({sessionId:'s',toolCallId:'large-unicode',toolName:'Read',input:'x',result:text})).eventId!;
  const first=await service.execute('content',{scopeId,eventId:id,limit:64000}) as any;
  assert.equal(first.text.length,63999);assert.equal(first.nextOffset,63999);
  const second=await service.execute('content',{scopeId,eventId:id,offset:first.nextOffset,limit:64000}) as any;
  assert.equal(first.text+second.text,text);
});

test('settings reject carrying a stored key to another origin and credentials over cleartext http',async t=>{
  const {dir,service}=await fixture(t);const cfg=loadConfig(dir);
  cfg.providers.retention=[{kind:'openai-compatible',name:'remote',model:'m',apiKey:'PRIVATE_KEY',baseUrl:'https://api.example.test/v1?api-version=2024-01'}];saveConfig(cfg);
  const entry={kind:'openai-compatible',name:'remote',model:'m',baseUrl:'https://api.example.test/v1',keyAction:'keep'};
  const attempt=async(provider:Record<string,unknown>)=>service.execute('saveSettings',{expectedRevision:configRevision(dir),patch:{providers:{retention:[provider]}}});
  const before=fs.readFileSync(path.join(dir,'config.json'));
  for(const baseUrl of ['https://other.example.test/v1','https://api.example.test:8443/v1','http://127.0.0.1:9/v1',undefined]) {
    await assert.rejects(attempt({...entry,baseUrl}),/stored API key cannot be kept/,String(baseUrl));
    assert.deepEqual(fs.readFileSync(path.join(dir,'config.json')),before);
  }
  await assert.rejects(attempt({...entry,keyAction:'replace',newKey:'K2',baseUrl:'http://10.0.0.5/v1'}),/requires an https baseUrl/);
  await assert.rejects(attempt({...entry,keyAction:'delete',apiKeyEnv:'CMM_ENV_KEY',baseUrl:'http://10.0.0.5/v1'}),/requires an https baseUrl/);
  await assert.rejects(attempt({...entry,apiKeyEnv:'bad-name'}),/Invalid API key environment variable/);
  assert.deepEqual(fs.readFileSync(path.join(dir,'config.json')),before);
  await attempt({...entry,model:'edited'});
  assert.equal(loadConfig(dir).providers.retention[0].baseUrl,'https://api.example.test/v1?api-version=2024-01');
  await attempt({...entry,keyAction:'replace',newKey:'K2',baseUrl:'http://localhost:1234/v1'});
  assert.equal(loadConfig(dir).providers.retention[0].apiKey,'K2');
  await attempt({...entry,keyAction:'delete',baseUrl:'http://10.0.0.5/v1'});
  assert.equal(loadConfig(dir).providers.retention[0].apiKey,undefined);
});

test('a save whose writer lock cannot be removed is reported as saved with a static warning, not as a failure',async t=>{
  const {dir,service}=await fixture(t);const lock=path.join(dir,'config.write.lock');
  // Runs inside the lock: move our lock file away and put a directory in its place, so releasing it fails with a non-busy error.
  const patch={integration:{captureOnly:true},get strategy(){fs.renameSync(lock,lock+'.moved');fs.mkdirSync(lock);return 'conservative';}};
  const result=await service.execute('saveSettings',{expectedRevision:configRevision(dir),patch}) as any;
  assert.equal(result.saved,true);assert.equal(result.reloadRequired,true);assert.equal(result.strategy,'conservative');assert.equal(result.integration.captureOnly,true);
  assert.deepEqual(result.warning,{code:'CONFIG_LOCK_LEFT',message:'Settings were saved, but the configuration writer lock could not be removed. Close other CMM processes, then delete config.write.lock in the storage folder.'});
  assert.equal(result.revision,configRevision(dir),'the returned revision is the saved file, so the next save does not conflict');
  assert.equal(loadConfig(dir).strategy,'conservative');assert.equal(loadConfig(dir).integration.captureOnly,true);
  assert.ok(!JSON.stringify(result.warning).includes(dir),'no path reaches the browser');
  fs.rmdirSync(lock);
  await service.execute('saveSettings',{expectedRevision:result.revision,patch:{strategy:'aggressive'}});
  assert.equal(loadConfig(dir).strategy,'aggressive');
});
