// Test the distributable, not the checkout. No registry/network needed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'cmm-package-'));
let cleanupSafe=true;
let interrupted=false,lifecycle,interruptPending;
const interrupt=()=>{
  interrupted=true;
  if(lifecycle){void lifecycle.shutdown().catch(()=>{});interruptPending?.(new Error('Pack smoke interrupted'));}
};
process.on('SIGINT',interrupt);process.on('SIGTERM',interrupt);
const run=(args,options={})=>{if(interrupted)throw new Error('Pack smoke interrupted');const r=spawnSync(process.execPath,args,{encoding:'utf8',timeout:20000,...options});assert.equal(r.status,0,r.stderr);return r.stdout;};
try {
  assert.ok(process.env.npm_execpath,'Run this check with npm run test:pack');
  const packed=JSON.parse(run([process.env.npm_execpath,'pack','--offline','--ignore-scripts','--json','--pack-destination',tmp]))[0];
  assert.ok(packed.files.some(f=>f.path==='dist/src/integrations/opencode.js'));
  assert.ok(packed.files.some(f=>f.path==='dist/src/cli.js'));
  for (const doc of ['README.md','README.zh-CN.md','docs/RELEASE_VALIDATION.md','docs/PROJECT_REVIEW.zh-CN.md','docs/IMPLEMENTATION_REPORT.zh-CN.md','docs/AUDIT.md'])
    assert.ok(packed.files.some(f=>f.path===doc), 'Missing release documentation: '+doc);
  assert.ok(!packed.files.some(f=>f.path.startsWith('node_modules/') || f.path.startsWith('dist/tests/') || /(?:\.db(?:-|$)|\.env$)/.test(f.path)));
  const tarball=path.join(tmp,packed.filename);
  // npm installs a local dependency archive into an isolated prefix without scripts.
  const prefix=path.join(tmp,'consumer');fs.mkdirSync(prefix);
  run([process.env.npm_execpath,'install','--offline','--ignore-scripts','--no-audit','--no-fund','--prefix',prefix,tarball]);
  const base=path.join(prefix,'node_modules','context-memory-manager');
  const {observeChild}=await import(pathToFileURL(path.join(base,'dist','src','util','child-lifecycle.js')).href);
  if(interrupted)throw new Error('Pack smoke interrupted');
  const meta=JSON.parse(fs.readFileSync(path.join(base,'package.json'),'utf8'));
  assert.ok(!meta.dependencies || Object.keys(meta.dependencies).length===0);
  const cli=path.join(base,'dist','src','cli.js');assert.match(run([cli,'--help']),/Keep the evidence/);
  assert.equal(run([cli,'--version']).trim(),meta.version);
  const demo=JSON.parse(run([cli,'demo']));assert.equal(demo.exactRecallVerified,true);assert.ok(demo.projectedChars<demo.originalChars);
  const state=path.join(tmp,'state');const workspace=path.join(tmp,'workspace');fs.mkdirSync(workspace);
  // Kimi hooks are user-level; never touch the developer's real Kimi Code config.
  const kimiHome=path.join(tmp,'kimi-home'),kimiConfig=path.join(kimiHome,'config.toml'),kimiBefore='default_model = "fixture"\n';
  fs.mkdirSync(kimiHome);fs.writeFileSync(kimiConfig,kimiBefore);const env={...process.env,KIMI_CODE_HOME:kimiHome};
  const preview=JSON.parse(run([cli,'setup','all','--dry-run','--workspace',workspace,'--storage',state],{env}));assert.equal(preview.dryRun,true);assert.equal(fs.existsSync(state),false);
  assert.ok(preview.writes.some(w=>w.file===kimiConfig));assert.equal(fs.readFileSync(kimiConfig,'utf8'),kimiBefore);
  run([cli,'setup','all','--workspace',workspace,'--storage',state],{env});assert.match(fs.readFileSync(kimiConfig,'utf8'),/PostToolUseFailure/);
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
  }finally{
    try{await lifecycle.shutdown();}
    catch(error){cleanupSafe=false;console.error('Packaged MCP close could not be confirmed; temporary directory retained: '+tmp);throw error;}
    finally{failPending(new Error('Packaged MCP smoke finished'));lines.close();interruptPending=undefined;}
  }
  console.log(JSON.stringify({package:packed.filename,files:packed.files.length,packedBytes:packed.size,unpackedBytes:packed.unpackedSize,isolatedInstall:true,registryRequired:false,help:true,demo:true,setupAndUninstall:true,mcpHandshake:true,demoProof:demo},null,2));
} catch(error) {
  if(!interrupted)throw error;
  console.error('Pack smoke interrupted: '+String(error));process.exitCode=130;
} finally {
  process.off('SIGINT',interrupt);process.off('SIGTERM',interrupt);
  if(cleanupSafe)fs.rmSync(tmp,{recursive:true,force:true});
}
