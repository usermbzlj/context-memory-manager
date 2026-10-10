import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startDashboard } from '../src/dashboard/server.js';
import { makeManager, cleanup, sampleInput } from './util.js';
import { removeDir } from './remove-dir.js';

test('installed-assets dashboard authenticates, blocks cross-origin/CSRF, and preserves verified original downloads',async t=>{
  const {manager,dir}=await makeManager();
  const source='\ufeffhello\r\n<script>window.attack=1</script>\0🙂';
  const record=await manager.recordToolComplete(sampleInput({result:source}));
  const dashboard=await startDashboard({storage:dir});
  t.after(async()=>{await dashboard.close();await cleanup(dir,manager);});
  const url=dashboard.url;
  const page=await fetch(url);assert.equal(page.status,200);
  assert.match(page.headers.get('content-security-policy')!,/frame-ancestors 'none'/);
  const html=await page.text();assert.match(html,/<script[^>]+src=/);
  const script=/src="([^"]+\.js)"/.exec(html)?.[1];assert.ok(script);
  assert.equal((await fetch(new URL(script,url+'/'))).status,200);
  assert.equal((await fetch(url+'/api/session')).status,401);
  assert.equal((await fetch(url+'/api/command',{method:'POST',headers:{'content-type':'application/json',origin:'https://foreign.invalid'},body:'{}'})).status,403);
  const token=new URL(dashboard.launchUrl).hash.slice('#token='.length);
  const login=await fetch(url+'/api/session',{method:'POST',headers:{'content-type':'application/json',origin:url},body:JSON.stringify({token})});
  assert.equal(login.status,200);
  const cookie=login.headers.get('set-cookie')!.split(';')[0];
  assert.equal(cookie.split('=')[0],'cmm_session_'+new URL(url).port);
  assert.match(login.headers.get('set-cookie')!,/HttpOnly; SameSite=Strict/);
  const csrf=(await login.json() as {csrfToken:string}).csrfToken;
  const replay=await fetch(url+'/api/session',{method:'POST',headers:{'content-type':'application/json',origin:url},body:JSON.stringify({token})});
  assert.equal(replay.status,401);
  const headers={'content-type':'application/json',origin:url,cookie,'x-cmm-csrf':csrf};
  const invoke=async(method:string,params:Record<string,unknown>={})=>{
    const response=await fetch(url+'/api/command',{method:'POST',headers,body:JSON.stringify({method,params})});
    assert.equal(response.status,200,method);return (await response.json() as {result:any}).result;
  };
  const scopes=await invoke('scopes');const scopeId=scopes.scopes[0].id;
  assert.equal((await fetch(url+'/api/command',{method:'POST',headers:{'content-type':'application/json',origin:url,cookie},body:JSON.stringify({method:'scopes',params:{}})})).status,403);
  const content=await invoke('content',{scopeId,eventId:record.eventId,field:'result'});assert.equal(content.text,source);
  const download=await fetch(url+'/api/download?'+new URLSearchParams({scopeId,eventId:record.eventId!,field:'result'}),{headers:{cookie}});
  assert.equal(download.status,200);assert.ok(Buffer.from(await download.arrayBuffer()).equals(Buffer.from(source,'utf8')));
  assert.match(download.headers.get('content-disposition')!,/attachment/);
  const forbidden=await fetch(url+'/api/command',{method:'POST',headers,body:JSON.stringify({method:'content',params:{scopeId:'foreign',eventId:record.eventId}})});
  assert.equal(forbidden.status,404);
  const runtime=await invoke('runtime',{scopeId});assert.equal(runtime.server.status,'ready');
  assert.equal(runtime.scope.agent,'test-agent');
  const job=await invoke('startJob',{scopeId,reindex:false});assert.ok(job.id);
  let jobFinished=false;
  for(let i=0;i<30;i++){
    const {jobs}=await invoke('jobs',{scopeId});if(jobs[0].status!=='running'){assert.equal(jobs[0].status,'completed');assert.equal(jobs[0].result.failed,0);jobFinished=true;break;}
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.equal(jobFinished,true,'verification completes and is observable');
  const snapshot=await invoke('settings');assert.equal(JSON.stringify(snapshot).includes('apiKey"'),false);
  const saved=await invoke('saveSettings',{expectedRevision:snapshot.revision,patch:{strategy:'conservative'}});assert.equal(saved.adopted,true);
  const stale=await fetch(url+'/api/command',{method:'POST',headers,body:JSON.stringify({method:'saveSettings',params:{expectedRevision:snapshot.revision,patch:{strategy:'aggressive'}}})});
  assert.equal(stale.status,409);
});

test('dashboard refuses unknown storage instead of creating an empty archive',async()=>{
  await assert.rejects(()=>startDashboard({storage:'D:/__cmm_unknown_storage_do_not_create'}),/existing CMM storage/);
});

test('a worker that never acknowledges startJob cannot pin a queue slot or a running job past the late-retention cap',async t=>{
  const {manager,dir}=await makeManager();
  const stub=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'cmm-stall-worker-')),'worker.mjs');
  // Answers scope lookups only; startJob is swallowed and the process stays alive.
  fs.writeFileSync(stub,`process.send({type:'ready'});process.stdin.resume();process.stdin.on('end',()=>process.exit(0));process.on('disconnect',()=>process.exit(0));
process.on('message',m=>{if(m.method==='scope')process.send({type:'response',id:m.id,result:{agent:'a',workspaceId:'w'}});});`);
  const dashboard=await startDashboard({storage:dir,internals:{worker:stub,requestMs:100,lateMs:600}});
  t.after(async()=>{await dashboard.close();removeDir(path.dirname(stub));await cleanup(dir,manager);});
  const url=dashboard.url,token=new URL(dashboard.launchUrl).hash.slice('#token='.length);
  const login=await fetch(url+'/api/session',{method:'POST',headers:{'content-type':'application/json',origin:url},body:JSON.stringify({token})});
  const headers={'content-type':'application/json',origin:url,cookie:login.headers.get('set-cookie')!.split(';')[0],'x-cmm-csrf':(await login.json() as {csrfToken:string}).csrfToken};
  const call=async(method:string,params:Record<string,unknown>)=>{
    const response=await fetch(url+'/api/command',{method:'POST',headers,body:JSON.stringify({method,params})});
    return {status:response.status,body:await response.json() as any};
  };
  const params={scopeId:'s'};
  const started=await call('startJob',params);
  assert.equal(started.status,504);assert.equal(started.body.error.code,'TIMEOUT');
  const during=await call('runtime',params);
  assert.equal(during.body.result.jobs.length,1,'the late entry keeps the job visible while a late answer is still possible');
  assert.equal(during.body.result.jobs[0].status,'running');assert.equal(during.body.result.worker.status,'busy');
  assert.equal((await call('startJob',params)).body.error.code,'JOB_RUNNING');
  let released:any;
  for(let i=0;i<60;i++){
    await new Promise(resolve=>setTimeout(resolve,50));
    const now=await call('runtime',params);
    if(now.body.result.jobs.length===0){released=now.body.result;break;}
  }
  assert.ok(released,'the job record is dropped after the retention cap');
  assert.equal(released.worker.status,'ready','the pending slot is freed');
  assert.equal((await call('startJob',params)).body.error.code,'TIMEOUT','a new job can be attempted again (and times out the same way)');
});
