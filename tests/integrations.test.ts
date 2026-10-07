import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseHook, executeHook, errorStatus } from '../src/integrations/hooks.js';
import { planSetup, applySetup, prepareKimiLaunch, replaceManagedBlock, shellQuote, type SetupOptions } from '../src/integrations/setup.js';
import { createOpenCodePlugin, openCodeWorkspace, type OpenCodeToolFactory } from '../src/integrations/opencode.js';
import { MemoryService } from '../src/runtime/memory.js';
import { windowsBatchLine } from '../src/util/spawn.js';
import { makeManager, cleanup, registerCleanup } from './util.js';
const cli=fileURLToPath(new URL('../src/cli.js',import.meta.url));
const raw='initial log\n'+'important historical evidence\n'.repeat(2500)+'\n30 passed, 0 failed\n';
async function fixture(t:TestContext,agent='claude') {const {manager,dir}=await makeManager();t.after(()=>cleanup(dir,manager));return {manager,dir,service:new MemoryService(manager,{agent,workspaceId:dir})};}
function payload(cwd:string,changes:Record<string,unknown>={}) {return {hook_event_name:'PostToolUse',session_id:'host-same-id',tool_use_id:'call',cwd,tool_name:'Bash',tool_input:{command:'cat test.log'},tool_response:{stdout:raw,stderr:'do not lose stderr',interrupted:false,isImage:false,extra:'preserved'},...changes};}
function toolFactory():OpenCodeToolFactory {const node:any={optional:()=>node,int:()=>node,min:()=>node,max:()=>node};const tool:any=(value:unknown)=>value;tool.schema={string:()=>node,number:()=>node,boolean:()=>node,enum:()=>node};return tool;}
function run(args:string[],input?:string) {return spawnSync(process.execPath,[cli,...args],{input,encoding:'utf8',timeout:10000});}

test('Claude native hook replaces only successful canonical Bash stdout and preserves all metadata',async t=>{
  const {service,dir}=await fixture(t);service.manager.config.integration.ingressCompression=true;const p=payload(dir);const before=structuredClone(p);const result=await executeHook(service,'claude',parseHook('claude',p)!) as any;
  assert.match(result.hookSpecificOutput.updatedToolOutput.stdout,/^\[CMM archive /);assert.equal(result.hookSpecificOutput.updatedToolOutput.stderr,'do not lose stderr');
  assert.equal(result.hookSpecificOutput.updatedToolOutput.extra,'preserved');assert.deepEqual(p,before);
  const id=service.search().results[0].eventId;assert.deepEqual(JSON.parse((await service.manager.archive.fetchOriginal(id)).result),before.tool_response);
  assert.equal((await service.verify()).failed,0);
});
test('Claude structured unknown shapes and failures never emit a replacement',async t=>{
  const {service,dir}=await fixture(t);
  for(const [i,changes] of [{tool_response:{content:[{type:'text',text:raw}]}},{hook_event_name:'PostToolUseFailure',error:'failed '+raw},{tool_response:{stdout:raw,stderr:'',interrupted:true,isImage:false}},{tool_name:'Read'}].entries()) {
    const p=payload(dir,{...changes,tool_use_id:'c'+i});assert.equal(await executeHook(service,'claude',parseHook('claude',p)!),undefined);
  }
});
test('Codex captures stdout silently and never uses block, continue or additionalContext as compression',async t=>{
  const {service,dir}=await fixture(t,'codex');const result=await executeHook(service,'codex',parseHook('codex',payload(dir))!);
  assert.equal(result,undefined);assert.equal(service.search().results.length,1);
});
test('Kimi accepts tool_output and generates observation IDs when the post hook has no call ID',async t=>{
  const {service,dir}=await fixture(t,'kimi');const p=payload(dir,{tool_use_id:undefined,tool_output:raw});
  assert.equal(await executeHook(service,'kimi',parseHook('kimi',p)!),undefined);await executeHook(service,'kimi',parseHook('kimi',p)!);
  assert.equal(service.search().results.length,2);assert.ok(service.search().results.every(r=>r.toolCallId.startsWith('observed:')));
});
test('own memory tools are ignored and failure markers are conservative',async t=>{
  const {dir}=await fixture(t);assert.equal(parseHook('claude',payload(dir,{tool_name:'mcp__context_memory__context_search'})),null);
  assert.equal(errorStatus('Process exited with code 1'),'error');assert.equal(errorStatus({output:'Exit code: 2'}),'error');assert.equal(errorStatus({exitCode:4}),'error');
});
test('archive failure keeps the native result unchanged',async t=>{
  const {service,manager,dir}=await fixture(t);manager.archive.failNextArchive();const p=payload(dir);const snapshot=JSON.stringify(p);
  assert.equal(await executeHook(service,'claude',parseHook('claude',p)!),undefined);assert.equal(JSON.stringify(p),snapshot);
});
test('actual hook CLI fails open for malformed input, invalid config and unrelated workspaces',async t=>{
  const {dir}=await fixture(t);const args=['hook','claude','--workspace',dir,'--storage',dir];
  const broken=run(args,'{broken');assert.equal(broken.status,0);assert.equal(broken.stdout,'');
  const outside=run(args,JSON.stringify(payload(path.dirname(dir))));assert.equal(outside.status,0);assert.equal(outside.stdout,'');assert.match(outside.stderr,/outside/);
  fs.writeFileSync(path.join(dir,'config.json'),'{broken');const cfg=run(args,JSON.stringify(payload(dir)));assert.equal(cfg.status,0);assert.equal(cfg.stdout,'');
});
test('actual Codex hook persists a searchable event without polluting stdout',async t=>{
  const {dir}=await fixture(t);const hook=run(['hook','codex','--workspace',dir,'--storage',dir],JSON.stringify(payload(dir)));assert.equal(hook.status,0);assert.equal(hook.stdout,'');
  const found=run(['search','--agent','codex','--workspace',dir,'--storage',dir]);assert.equal(found.status,0);assert.equal(JSON.parse(found.stdout).results.length,1);
});
test('setup preview writes nothing and excludes existing secrets from CLI output',async t=>{
  const {dir}=await fixture(t);const ws=path.join(dir,'workspace');fs.mkdirSync(ws);fs.mkdirSync(path.join(ws,'.claude'));
  const file=path.join(ws,'.claude','settings.local.json');fs.writeFileSync(file,JSON.stringify({env:{API_KEY:'private-secret-example'}}));
  const result=run(['setup','claude','--dry-run','--workspace',ws,'--storage',dir]);assert.equal(result.status,0);assert.ok(!result.stdout.includes('private-secret-example'));
  assert.equal(fs.existsSync(path.join(ws,'.mcp.json')),false);assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).env.API_KEY,'private-secret-example');
});
test('Claude setup preserves unrelated hooks and MCP servers, backs up originals and is idempotent',async t=>{
  const {dir}=await fixture(t);const ws=path.join(dir,'ws');fs.mkdirSync(path.join(ws,'.claude'),{recursive:true});
  const hooks=path.join(ws,'.claude','settings.local.json'),mcp=path.join(ws,'.mcp.json');
  fs.writeFileSync(hooks,JSON.stringify({env:{KEEP:'yes'},hooks:{PostToolUse:[{matcher:'Read',hooks:[{type:'command',command:'keep-original-hook'}]}]}}));
  fs.writeFileSync(mcp,JSON.stringify({mcpServers:{existing:{command:'my-existing-server'}}}));
  const opts:SetupOptions={agent:'claude',workspace:ws,storage:dir,cli};const result=applySetup(planSetup(opts));assert.equal(result.backups.length,2);
  const saved=JSON.parse(fs.readFileSync(hooks,'utf8'));assert.equal(saved.env.KEEP,'yes');assert.equal(saved.hooks.PostToolUse.length,2);
  assert.equal(JSON.parse(fs.readFileSync(mcp,'utf8')).mcpServers.existing.command,'my-existing-server');assert.equal(applySetup(planSetup(opts)).written.length,0);
});
test('unmanaged config conflicts and malformed blocks are refused without overwriting',async t=>{
  const {dir}=await fixture(t);fs.mkdirSync(path.join(dir,'.codex'));const cfg=path.join(dir,'.codex','config.toml');const original='[mcp_servers . "context_memory"]\ncommand="someone-else"\n';fs.writeFileSync(cfg,original);
  assert.throws(()=>planSetup({agent:'codex',workspace:dir,storage:dir,cli}),/refusing/);assert.equal(fs.readFileSync(cfg,'utf8'),original);
  assert.throws(()=>replaceManagedBlock('text # BEGIN CMM MANAGED\n# END CMM MANAGED\n','x'),/Malformed/);
  fs.writeFileSync(cfg,'mcp_servers = { other = { command = "other" } }\n');assert.throws(()=>planSetup({agent:'codex',workspace:dir,storage:dir,cli}),/refusing/);
});
test('Codex TOML surgical merge preserves user bytes and has no approval bypass',async t=>{
  const {dir}=await fixture(t);fs.mkdirSync(path.join(dir,'.codex'));const cfg=path.join(dir,'.codex','config.toml');const before='# keep this comment\nmodel="my-model"\n[other]\nvalue=42\n';fs.writeFileSync(cfg,before);
  const o:SetupOptions={agent:'codex',workspace:dir,storage:dir,cli};applySetup(planSetup(o));const after=fs.readFileSync(cfg,'utf8');assert.ok(after.startsWith(before));assert.match(after,/\[mcp_servers.context_memory\]/);assert.ok(!after.includes('approval_policy'));
  assert.equal(applySetup(planSetup(o)).written.length,0);
});
test('a config changed after planning is not overwritten',async t=>{
  const {dir}=await fixture(t);const changes=planSetup({agent:'claude',workspace:dir,storage:dir,cli});fs.mkdirSync(path.dirname(changes[0].file),{recursive:true});fs.writeFileSync(changes[0].file,'{"edited":true}');
  assert.throws(()=>applySetup(changes),/changed/);assert.equal(fs.readFileSync(changes[0].file,'utf8'),'{"edited":true}');assert.equal(fs.existsSync(changes[1].file),false);
});
test('Windows commands quote spaces and refuse shell metacharacters; POSIX apostrophes are escaped',()=>{
  assert.equal(shellQuote('C:\\Program Files\\nodejs\\node.exe','win32'),'"C:/Program Files/nodejs/node.exe"');
  assert.throws(()=>shellQuote('C:\\bad&path','win32'),/Unsupported/);assert.throws(()=>windowsBatchLine('kimi.cmd',['hello & bye']),/Unsafe/);
  assert.equal(shellQuote("a'b",'linux'),"'a'\\''b'");assert.match(windowsBatchLine('C:\\Program Files\\kimi.cmd',['--flag','a b']),/^""C:/);
});
test('Kimi launch uses a private temporary sibling and leaves original config untouched',async t=>{
  const {dir}=await fixture(t);const source=path.join(dir,'config.toml');const before='default_model="existing"\n[[hooks]]\nevent="Stop"\ncommand="my-hook"\n';fs.writeFileSync(source,before);
  const plan=prepareKimiLaunch({workspace:dir,storage:dir,cli,configFile:source});try {
    const config=fs.readFileSync(plan.files[0],'utf8');assert.ok(config.startsWith(before));assert.match(config,/PostToolUseFailure/);assert.equal(path.dirname(plan.files[0]),dir);
    assert.equal(fs.readFileSync(source,'utf8'),before);if(process.platform!=='win32')assert.equal(fs.statSync(plan.files[0]).mode&0o777,0o600);
    assert.equal(plan.args.filter(v=>v==='--config-file').length,1);assert.ok(!plan.args.includes('--yolo'));
  }finally{plan.cleanup();}assert.ok(plan.files.every(f=>!fs.existsSync(f)));
});
test('OpenCode contract changes only completed tool-result text; user/prose/input/attachments remain intact',async()=>{
  const calls:any[]=[];const bridge={async request(method:string,params:any){calls.push({method,params});if(method==='capture')return {archived:true,eventId:'event'};if(method==='transform')return {projections:[{eventId:'event',text:'compact evidence',replaced:true}]};return {};},close(){}};
  const plugin=await createOpenCodePlugin({directory:'/workspace'},{node:process.execPath,cli,storage:'/unused',tool:toolFactory(),bridge:bridge as any});
  const messages:any[]=[{info:{role:'user',sessionID:'s'},parts:[{type:'text',text:'never rewrite user'}]},
    {info:{role:'assistant',sessionID:'s'},parts:[{type:'text',text:'never rewrite assistant'},{type:'tool',tool:'Read',callID:'call',state:{status:'completed',input:{file:'x'},output:'original'}},{type:'tool',tool:'Read',callID:'pending',state:{status:'running',input:{}}},{type:'tool',tool:'Read',callID:'image',state:{status:'completed',input:{},output:'image caption',attachments:[{type:'image'}]}}]}];
  const before=structuredClone(messages);await plugin['experimental.chat.messages.transform']({}, {messages});assert.deepEqual(messages,before,'new output is presented once before compression');await plugin['experimental.chat.messages.transform']({}, {messages});const expected=structuredClone(before);expected[1].parts[1].state.output='compact evidence';assert.deepEqual(messages,expected);
  assert.equal(calls.filter(c=>c.method==='capture').length,1);await plugin.dispose();
});
test('real OpenCode plugin Node bridge archives, projects, resumes and restores a pinned result',async t=>{
  const {manager,dir,service}=await fixture(t,'opencode');
  const create=()=>createOpenCodePlugin({directory:dir},{node:process.execPath,cli,storage:dir,tool:toolFactory()});let plugin=await create();registerCleanup(manager,()=>plugin.dispose());
  await plugin['chat.params']({sessionID:'session',model:{limit:{context:10000}}});
  const input={file:'test.log'};await plugin['tool.execute.after']({tool:'Read',sessionID:'session',callID:'call',args:input},{output:raw});
  const id=service.search().results[0].eventId;assert.ok(id);manager.db.updateToolEvent(id,{state:'capsule',protected_until_turn:0});
  const messages:any[]=[{info:{role:'assistant',sessionID:'session'},parts:[{type:'tool',tool:'Read',callID:'call',state:{status:'completed',input,output:raw}}]}];
  await plugin['experimental.chat.messages.transform']({}, {messages});assert.equal(messages[0].parts[0].state.output,raw);await plugin['experimental.chat.messages.transform']({}, {messages});assert.match(messages[0].parts[0].state.output,/^\[CMM archive /);
  await plugin.dispose();plugin=await create();await service.pin(id,true);await plugin['experimental.chat.messages.transform']({}, {messages});assert.equal(messages[0].parts[0].state.output,raw);
});
test('OpenCode native truncation metadata protects after-hook and transform-only captures from recompression',async t=>{
  const {manager,dir,service}=await fixture(t,'opencode');
  const plugin=await createOpenCodePlugin({directory:dir},{node:process.execPath,cli,storage:dir,tool:toolFactory()});
  registerCleanup(manager,()=>plugin.dispose());
  await plugin['chat.params']({sessionID:'partial-session',model:{limit:{context:10000}}});
  // OpenCode 1.18.29 read/grep report partial results in metadata. Their text
  // does not necessarily contain the generic truncation markers CMM detects.
  const read='<path>log.txt</path>\n<content>\n'+'source line evidence\n'.repeat(2500)+
    '\n(Showing lines 1-2000 of 6000. Use offset=2001 to continue.)\n</content>';
  const grep='Found 100 matches (more matches available)\n'+'  Line 12: matching source evidence\n'.repeat(2500)+
    '\n(Results truncated. Consider using a more specific path or pattern.)';
  const metadata={truncated:true};
  await plugin['tool.execute.after']({tool:'read',sessionID:'partial-session',callID:'native-after',args:{filePath:'log.txt'}},{output:read,metadata});
  const messages:any[]=[{info:{role:'assistant',sessionID:'partial-session'},parts:[
    {type:'tool',tool:'read',callID:'native-after',state:{status:'completed',input:{filePath:'log.txt'},output:read,metadata}},
    {type:'tool',tool:'grep',callID:'missed-after',state:{status:'completed',input:{pattern:'evidence'},output:grep,metadata}},
  ]}];
  await plugin['experimental.chat.messages.transform']({}, {messages});
  for(const [call,tool,original] of [['native-after','read',read],['missed-after','grep',grep]]) {
    const id=service.lookup('partial-session',call,tool)!.eventId;
    assert.equal(service.explain(id).provenance.completeness,'partial');
    assert.equal(service.explain(id).provenance.captureStage,'host-result');
    assert.equal((await manager.archive.fetchOriginal(id)).result,original);
    // Isolate the partial-evidence protection from unrelated age/scoring guards.
    manager.db.updateToolEvent(id,{state:'capsule',protected_until_turn:0});
  }
  await plugin['experimental.chat.messages.transform']({}, {messages});
  assert.deepEqual(messages[0].parts.map((part:any)=>part.state.output),[read,grep]);
  assert.equal(manager.db.queryOne<{n:number}>('SELECT count(*) n FROM projection_cache')!.n,0);
});

test('OpenCode disposal waits for the bridge and repeated disposal shares its completion',async()=>{
  let finish!:()=>void;let closes=0;
  const bridge={async request(){return {};},close(){closes++;return new Promise<void>(resolve=>{finish=resolve;});}};
  const plugin=await createOpenCodePlugin({directory:'/workspace'},{node:process.execPath,cli,storage:'/unused',tool:toolFactory(),bridge:bridge as any});
  const closing=plugin.dispose();assert.equal(plugin.dispose(),closing);
  let complete=false;void closing.then(()=>{complete=true;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(complete,false);assert.equal(closes,1);
  finish();await closing;assert.equal(complete,true);
});
test('CLI help and unknown commands do not create storage, exports refuse overwrite',async t=>{
  const {dir,service}=await fixture(t);const absent=path.join(dir,'absent');assert.equal(run(['--help','--storage',absent]).status,0);const version=run(['--version','--storage',absent]);assert.equal(version.status,0);assert.equal(version.stdout.trim(),(await import('../src/cli.js')).VERSION);assert.equal(fs.existsSync(absent),false);
  assert.equal(run(['nonexistent','--storage',absent]).status,1);assert.equal(fs.existsSync(absent),false);
  const id=(await service.capture({sessionId:'s',toolName:'Read',input:'x',result:'exact\r\n\u4f60\u597d'})).eventId!;const out=path.join(dir,'export.txt');
  const args=['recall',id,'--agent','claude','--workspace',dir,'--storage',dir,'--out',out];assert.equal(run(args).status,0);assert.equal(fs.readFileSync(out,'utf8'),'exact\r\n\u4f60\u597d');assert.equal(run(args).status,1);
});

test('uninstall is reversible, removes only marked config and never deletes the archive',async t=>{
  const {dir}=await fixture(t);const ws=path.join(dir,'ws');fs.mkdirSync(path.join(ws,'.claude'),{recursive:true});
  const file=path.join(ws,'.claude','settings.local.json');fs.writeFileSync(file,JSON.stringify({env:{KEEP:'yes'},hooks:{PostToolUse:[{hooks:[{type:'command',command:'my-hook'}]}]}}));
  for(const command of ['setup','uninstall']) {const result=run([command,'all','--workspace',ws,'--storage',dir]);assert.equal(result.status,0,result.stderr);}
  const config=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(config.env.KEEP,'yes');assert.equal(config.hooks.PostToolUse.length,1);assert.equal(config.hooks.PostToolUse[0].hooks[0].command,'my-hook');
  assert.equal(fs.existsSync(path.join(ws,'.opencode','plugins','context-memory-manager.ts')),false);assert.equal(fs.existsSync(path.join(dir,'cmm.db')),true);
  assert.equal(run(['uninstall','all','--workspace',ws,'--storage',dir]).status,0);
});


test('OpenCode global worktree sentinel never collapses unrelated projects into root',()=>{
  assert.equal(openCodeWorkspace({directory:'/project-a',worktree:'/'}),'/project-a');
  assert.equal(openCodeWorkspace({directory:'/project-b',worktree:'/'}),'/project-b');
  assert.equal(openCodeWorkspace({directory:'/repo/subdir',worktree:'/repo'}),'/repo');
});
