// Test the distributable, not the checkout. No registry/network needed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'cmm-package-'));
let cleanupSafe=true;
let interrupted=false,lifecycle,interruptPending;
const interrupt=()=>{
  interrupted=true;
  if(lifecycle){void lifecycle.shutdown().catch(()=>{});interruptPending?.(new Error('Pack smoke interrupted'));}
};
process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
const run=(args,options={})=>{if(interrupted)throw new Error('Pack smoke interrupted');const r=spawnSync(process.execPath,args,{encoding:'utf8',timeout:20000,...options});assert.equal(r.status,0,r.stderr||(r.error?.code==='ETIMEDOUT'?`timed out: ${path.basename(String(args[0]))} ${args[1]??''}`:`exited by ${r.signal}`));return r.stdout;};
// npm pack/install can take well over 20 s on shared Windows CI runners.
const NPM_TIMEOUT={timeout:180000};
try {
  assert.ok(process.env.npm_execpath,'Run this check with npm run test:pack');
  const packed=JSON.parse(run([process.env.npm_execpath,'pack','--offline','--ignore-scripts','--json','--pack-destination',tmp],NPM_TIMEOUT))[0];
  assert.ok(packed.files.some(f=>f.path==='dist/src/integrations/opencode.js'));
  assert.ok(packed.files.some(f=>f.path==='dist/src/cli.js'));
  assert.ok(packed.files.some(f=>f.path==='dist/src/dashboard/assets/index.html'));
  assert.ok(packed.files.some(f=>/^dist\/src\/dashboard\/assets\/assets\/.+\.js$/.test(f.path)));
  for (const doc of ['README.md','README.zh-CN.md','docs/RELEASE_VALIDATION.md','docs/PROJECT_REVIEW.zh-CN.md','docs/IMPLEMENTATION_REPORT.zh-CN.md','docs/AUDIT.md'])
    assert.ok(packed.files.some(f=>f.path===doc), 'Missing release documentation: '+doc);
  assert.ok(!packed.files.some(f=>f.path.startsWith('node_modules/') || f.path.startsWith('dist/tests/') || /(?:\.db(?:-|$)|\.env$)/.test(f.path)));
  assert.ok(!packed.files.some(f=>/(?:^|\/)(?:\.codex|\.claude|\.kimi-code|\.cmm)(?:\/|$)|\.cmm-backup-|\.env(?:\.|$)/.test(f.path)), 'Private local configuration must not enter the package');
  const tarball=path.join(tmp,packed.filename);
  // npm installs a local dependency archive into an isolated prefix without scripts.
  const prefix=path.join(tmp,'consumer');fs.mkdirSync(prefix);
  run([process.env.npm_execpath,'install','--offline','--ignore-scripts','--no-audit','--no-fund','--prefix',prefix,tarball],NPM_TIMEOUT);
  const base=path.join(prefix,'node_modules','context-memory-manager');
  const {observeChild}=await import(pathToFileURL(path.join(base,'dist','src','util','child-lifecycle.js')).href);
  if(interrupted)throw new Error('Pack smoke interrupted');
  const meta=JSON.parse(fs.readFileSync(path.join(base,'package.json'),'utf8'));
  assert.ok(!meta.dependencies || Object.keys(meta.dependencies).length===0);
  const cli=path.join(base,'dist','src','cli.js');assert.match(run([cli,'--help']),/Keep the evidence/);
  assert.equal(run([cli,'--version']).trim(),meta.version);
  const demo=JSON.parse(run([cli,'demo']));assert.equal(demo.exactRecallVerified,true);assert.ok(demo.projectedChars<demo.originalChars);
  const state=path.join(tmp,'state');const workspace=path.join(tmp,'workspace with spaces');fs.mkdirSync(workspace);
  // Kimi hooks are user-level; never touch the developer's real Kimi Code config.
  const kimiHome=path.join(tmp,'kimi-home'),kimiConfig=path.join(kimiHome,'config.toml'),kimiBefore='default_model = "fixture"\n';
  fs.mkdirSync(kimiHome);fs.writeFileSync(kimiConfig,kimiBefore);const env={...process.env,KIMI_CODE_HOME:kimiHome};
  const preview=JSON.parse(run([cli,'setup','all','--dry-run','--workspace',workspace,'--storage',state],{env}));assert.equal(preview.dryRun,true);assert.equal(fs.existsSync(state),false);
  assert.ok(preview.writes.some(w=>w.file===kimiConfig));assert.equal(fs.readFileSync(kimiConfig,'utf8'),kimiBefore);
  run([cli,'setup','all','--workspace',workspace,'--storage',state],{env});assert.match(fs.readFileSync(kimiConfig,'utf8'),/PostToolUseFailure/);
  // Execute the installed command through the host shell, not just node cli.js.
  // Direct argv tests missed the PowerShell call-operator failure in real setup.
  const command=JSON.parse(fs.readFileSync(path.join(workspace,'.codex','hooks.json'),'utf8')).hooks.PostToolUse[0].hooks[0].command;
  const shellArgs=process.platform==='win32'?['-NoLogo','-NoProfile','-NonInteractive','-Command',command]:['-c',command];
  let shell=process.platform==='win32'?'pwsh.exe':'/bin/sh';
  const observed='packaged hook exact evidence 中🚀\r\nsecond line\n';
  const hookInput=JSON.stringify({hook_event_name:'PostToolUse',session_id:'pack-hook',tool_use_id:'pack-call',cwd:workspace,
    tool_name:'exec_command',tool_input:{command:'isolated fixture'},tool_response:observed});
  const executeHook=input=>{
    const result=spawnSync(shell,shellArgs,{input,encoding:'utf8',timeout:20000,env});
    // spawnSync timeout only terminates the shell. Descendant/pipe closure is
    // unconfirmed in that case; keep the disposable archive for diagnosis.
    if(result.signal || (result.error && result.error.code!=='ENOENT'))cleanupSafe=false;
    return result;
  };
  let hooked=executeHook(hookInput);
  if(process.platform==='win32' && hooked.error?.code==='ENOENT'){shell='powershell.exe';hooked=executeHook(hookInput);}
  assert.equal(hooked.status,0,hooked.stderr);assert.equal(hooked.stdout,'');assert.equal(hooked.stderr,'');
  const hookScope=['--agent','codex','--workspace',workspace,'--storage',state];
  const evidence=JSON.parse(run([cli,'search',...hookScope])).results;assert.equal(evidence.length,1);
  assert.equal(JSON.parse(run([cli,'recall',evidence[0].eventId,...hookScope])).text,observed);
  const hookVerified=JSON.parse(run([cli,'verify',...hookScope]));assert.equal(hookVerified.checked,1);assert.equal(hookVerified.failed,0);
  // The installed package must serve its bundled UI and exact archive bytes.
  const {startDashboard}=await import(pathToFileURL(path.join(base,'dist','src','dashboard','server.js')).href);
  const panel=await startDashboard({storage:state});
  try {
    assert.equal((await fetch(panel.url+'/api/session')).status,401);
    const html=await (await fetch(panel.url)).text();
    const script=/src="([^"]+\.js)"/.exec(html)?.[1];assert.ok(script);
    assert.equal((await fetch(new URL(script,panel.url+'/'))).status,200);
    const login=await fetch(panel.url+'/api/session',{method:'POST',headers:{'content-type':'application/json',origin:panel.url},
      body:JSON.stringify({token:new URL(panel.launchUrl).hash.slice('#token='.length)})});
    assert.equal(login.status,200);
    const cookie=login.headers.get('set-cookie').split(';')[0],csrf=(await login.json()).csrfToken;
    const response=await fetch(panel.url+'/api/command',{method:'POST',headers:{'content-type':'application/json',origin:panel.url,cookie,'x-cmm-csrf':csrf},body:JSON.stringify({method:'scopes',params:{}})});
    assert.equal(response.status,200);const scopes=(await response.json()).result.scopes;assert.equal(scopes.length,1);
    const download=await fetch(panel.url+'/api/download?'+new URLSearchParams({scopeId:scopes[0].id,eventId:evidence[0].eventId,field:'result'}),{headers:{cookie}});
    assert.equal(download.status,200);assert.ok(Buffer.from(await download.arrayBuffer()).equals(Buffer.from(observed,'utf8')));
  }finally{
    try{await panel.close();}catch(error){cleanupSafe=false;throw error;}
  }
  const malformed=executeHook('{broken');assert.equal(malformed.status,0,malformed.stderr);assert.equal(malformed.stdout,'');
  assert.match(malformed.stderr,/Hook failed open/);
  run([cli,'uninstall','all','--workspace',workspace,'--storage',state],{env});assert.equal(fs.readFileSync(kimiConfig,'utf8'),kimiBefore);
  const child=spawn(process.execPath,[cli,'serve','--workspace',workspace,'--storage',state],{stdio:'pipe'});
  lifecycle=observeChild(child);
  let id=0;const waiting=new Map();const lines=createInterface({input:child.stdout});let failure='';child.stderr.on('data',b=>failure+=b.toString());
  const failPending=error=>{for(const item of waiting.values()){clearTimeout(item.timer);item.reject(error);}waiting.clear();};
  interruptPending=failPending;
  lines.on('line',line=>{let m;try{m=JSON.parse(line);}catch{failPending(new Error('Packaged MCP wrote invalid JSON'));return;}const item=waiting.get(m.id);if(item){clearTimeout(item.timer);waiting.delete(m.id);item.resolve(m);}});
  child.stdin.on('error',failPending);
  void lifecycle.closed.then(result=>failPending(result.error ?? new Error('Packaged MCP closed')));
  const request=(method,params={})=>new Promise((resolve,reject)=>{
    if(lifecycle.didClose){reject(new Error('Packaged MCP already closed'));return;}
    const next=++id;const timer=setTimeout(()=>{waiting.delete(next);reject(new Error('Packaged MCP timeout: '+failure));},5000);
    waiting.set(next,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:next,method,params})+'\n');
  });
  try {
    if(interrupted)throw new Error('Pack smoke interrupted');
    const init=await request('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'package-smoke',version:'1'}});assert.equal(init.result.protocolVersion,'2025-06-18');
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');const tools=await request('tools/list');assert.equal(tools.result.tools.length,5);
    const discover=await request('server/discover',{_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{}}});
    assert.ok(discover.result.supportedVersions.includes('2026-07-28'));
  }finally{
    try{await lifecycle.shutdown();}
    catch(error){cleanupSafe=false;console.error('Packaged MCP close could not be confirmed; temporary directory retained: '+tmp);throw error;}
    finally{failPending(new Error('Packaged MCP smoke finished'));lines.close();interruptPending=undefined;}
  }
  console.log(JSON.stringify({package:packed.filename,sha256:createHash('sha256').update(fs.readFileSync(tarball)).digest('hex'),files:packed.files.length,packedBytes:packed.size,unpackedBytes:packed.unpackedSize,isolatedInstall:true,registryRequired:false,help:true,demo:true,dashboardAssetsAndAuth:true,dashboardExactDownload:true,setupAndUninstall:true,generatedHookCapture:true,generatedHookFailOpen:true,mcpHandshake:true,demoProof:demo},null,2));
} catch(error) {
  if(!interrupted)throw error;
  console.error('Pack smoke interrupted: '+String(error));process.exitCode=130;
} finally {
  process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);
  if(cleanupSafe)fs.rmSync(tmp,{recursive:true,force:true});
  else console.error('Child closure unconfirmed; temporary directory retained: '+tmp);
}
