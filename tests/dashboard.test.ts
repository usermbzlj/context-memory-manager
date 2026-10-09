import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startDashboard } from '../src/dashboard/server.js';
import { makeManager, cleanup, sampleInput } from './util.js';

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
  assert.equal(forbidden.status,400);
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
