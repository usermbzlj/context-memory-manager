import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createOpenCodeV2Plugin, openCodeResultText, type OpenCodeV2Context } from '../src/integrations/opencode-v2.js';
import { planSetup, planUninstall, applySetup, openCodeConfigDir } from '../src/integrations/setup.js';
import { MEMORY_TOOLS } from '../src/mcp/tools.js';
import { MemoryService } from '../src/runtime/memory.js';
import { makeManager, cleanup, registerCleanup } from './util.js';
import { removeDir } from './remove-dir.js';

const cli=fileURLToPath(new URL('../src/cli.js',import.meta.url));
const raw='initial log\n'+'important historical evidence\n'.repeat(2500)+'\n30 passed, 0 failed\n';
async function fixture(t:TestContext) {const {manager,dir}=await makeManager();t.after(()=>cleanup(dir,manager));return {manager,dir,service:new MemoryService(manager,{agent:'opencode',workspaceId:dir})};}
function temp(t:TestContext) {const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cmm-oc2-'));t.after(()=>removeDir(dir));return dir;}

/** Stand-in for OpenCode's LLM.Message schema class. */
class LlmMessage {
  declare role:string;declare content:any[];
  constructor(input:{role:string;content:any[]}) {Object.assign(this,input);}
}
type Hook=(event:any)=>Promise<void>;
function fakeHost(location:OpenCodeV2Context['location']={directory:'/workspace',project:{directory:'/workspace'}},overrides:Partial<{transform:()=>Promise<never>}>={}) {
  const tools:any[]=[];const hooks:Record<string,Hook>={};const disposed:string[]=[];
  const registration=(name:string)=>({dispose:async()=>{disposed.push(name);}});
  const context:OpenCodeV2Context={
    location,
    tool:{
      transform:overrides.transform ?? (async callback=>{callback({add:tool=>tools.push(tool)});return registration('tools');}),
      hook:async(name,callback)=>{hooks[name]=callback;return registration(name);},
      list:async()=>[{id:'read',options:{codemode:false}},{id:'shell',options:{codemode:false}},{id:'mcp_lookup',options:{codemode:true}}],
    },
    session:{hook:async(name,callback)=>{hooks['session.'+name]=callback;return registration('session.'+name);}},
    model:{list:async()=>({location,data:[{providerID:'p',id:'m',limit:{context:10000,output:1000}}]})},
  };
  return {context,tools,hooks,disposed};
}
const after=(id:string,tool:string,content:unknown,metadata?:Record<string,unknown>,input:unknown={filePath:'test.log'})=>
  ({tool,sessionID:'session',agent:'build',messageID:'m1',id,input,status:'completed',result:{content,...(metadata?{metadata}:{})}});
const request=(messages:LlmMessage[])=>({sessionID:'session',agent:'build',model:{providerID:'p',id:'m'},system:[{type:'text',text:'never rewrite system'}],messages,options:{},tools:{}});
const history=(value:string,call='call')=>[
  new LlmMessage({role:'user',content:[{type:'text',text:'never rewrite user'}]}),
  new LlmMessage({role:'assistant',content:[{type:'text',text:'never rewrite assistant'},{type:'tool-call',id:call,name:'read',input:{filePath:'test.log'}}]}),
  new LlmMessage({role:'tool',content:[{type:'tool-result',id:call,name:'read',result:{type:'text',value}}]}),
];

test('OpenCode 2.x registers the five recall tools directly, outside code mode, with their JSON Schemas',async()=>{
  const calls:any[]=[];
  const bridge={async request(method:string,params:any){calls.push({method,params});return {ok:true};},close(){}};
  const {context,tools}=fakeHost();
  const dispose=await createOpenCodeV2Plugin(context,{node:process.execPath,cli,storage:'/unused',bridge:bridge as any});
  assert.deepEqual(tools.map(t=>t.name),MEMORY_TOOLS.map(t=>t.name));
  for(const [i,tool] of tools.entries()) {
    assert.deepEqual(tool.options,{codemode:false});assert.deepEqual(tool.input,MEMORY_TOOLS[i].inputSchema);
    assert.notEqual(tool.input,MEMORY_TOOLS[i].inputSchema,'host-owned schema copies cannot alter our definitions');
  }
  const result=await tools[0].execute({query:'evidence'},{sessionID:'session',signal:new AbortController().signal});
  assert.deepEqual(result,{content:JSON.stringify({ok:true})},'only content: OpenCode rejects output without an output schema');
  assert.deepEqual(calls,[{method:'tool',params:{name:'context_search',arguments:{query:'evidence'},sessionId:'session'}}]);
  await dispose();
});

test('OpenCode 2.x archives the exact model-visible text and changes only presented tool-result text in the outgoing request',async()=>{
  const calls:any[]=[];
  const bridge={async request(method:string,params:any){
    calls.push({method,params});
    if(method==='capture')return {archived:true,eventId:'event-'+params.toolCallId};
    if(method==='transform')return {projections:params.items.map((item:any)=>({eventId:item.eventId,text:'compact '+item.eventId,replaced:true}))};
    return {};
  },close(){}};
  const {context,hooks}=fakeHost();
  const dispose=await createOpenCodeV2Plugin(context,{node:process.execPath,cli,storage:'/unused',bridge:bridge as any});
  await hooks['execute.after'](after('call','read',[{type:'text',text:'original'}]));
  await hooks['execute.after']({...after('failed','read',undefined),status:'error',error:{message:'boom'}});
  await hooks['execute.after'](after('image','read',[{type:'text',text:'caption'},{type:'file',uri:'file:///x.png',mime:'image/png'}]));
  await hooks['execute.after'](after('own','context_search',[{type:'text',text:'{}'}]));
  const captures=()=>calls.filter(c=>c.method==='capture').map(c=>c.params);
  assert.deepEqual(captures().map(c=>[c.toolCallId,c.toolName,c.result,c.input]),[['call','read','original','{"filePath":"test.log"}']]);

  const persisted=[...history('original'),
    new LlmMessage({role:'assistant',content:[{type:'tool-call',id:'hosted',name:'web_search',input:{},providerExecuted:true},
      {type:'tool-result',id:'hosted',name:'web_search',providerExecuted:true,result:{type:'text',value:'hosted'}}]}),
    new LlmMessage({role:'tool',content:[{type:'tool-result',id:'failed',name:'read',result:{type:'error',value:'boom'}},
      {type:'tool-result',id:'image',name:'read',result:{type:'content',value:[{type:'text',text:'caption'}]}},
      {type:'tool-result',id:'own',name:'context_search',result:{type:'text',value:'{}'}}]}),
  ];
  const snapshot=JSON.stringify(persisted);
  const first=request([...persisted]);await hooks['session.context'](first);
  assert.equal(JSON.stringify(first.messages),snapshot,'a newly captured output is presented once before projection');
  const second=request([...persisted]);await hooks['session.context'](second);
  assert.equal(JSON.stringify(persisted),snapshot,'persisted history objects are never mutated');
  const expected=JSON.parse(snapshot);expected[2].content[0].result={type:'text',value:'compact event-call'};
  assert.deepEqual(JSON.parse(JSON.stringify(second.messages)),expected);
  assert.ok(second.messages[2] instanceof LlmMessage,'rebuilt messages keep their schema class');
  assert.equal(second.messages[0],persisted[0]);assert.equal(second.messages[1],persisted[1]);
  assert.equal(captures().length,1,'only the single-text local result is ever captured');
  const transform=calls.filter(c=>c.method==='transform').at(-1)!.params;
  assert.deepEqual(transform.items,[{eventId:'event-call',output:'original'}]);
  assert.equal(transform.usage.source,'estimated');assert.equal(transform.usage.contextWindow,10000);
  await dispose();
});

test('OpenCode 2.x keeps code-mode inner calls apart from the execute result that shares their call ID',async()=>{
  const calls:any[]=[];
  const bridge={async request(method:string,params:any){calls.push({method,params});return {archived:true,eventId:'event-'+params.toolCallId+'-'+params.toolName};},close(){}};
  const {context,hooks}=fakeHost();
  const dispose=await createOpenCodeV2Plugin(context,{node:process.execPath,cli,storage:'/unused',bridge:bridge as any});
  await hooks['execute.after'](after('exec','mcp_lookup',[{type:'text',text:'inner one'}]));
  await hooks['execute.after'](after('exec','mcp_lookup',[{type:'text',text:'inner two'}]));
  await hooks['execute.after'](after('exec','execute','script result'));
  await hooks['execute.after'](after('shell-call','shell',[{type:'text',text:'out'},{type:'text',text:'Exited with code 1'}],{exit:1,truncated:false}));
  assert.deepEqual(calls.map(c=>[c.params.toolCallId,c.params.toolName,c.params.result,c.params.status]),[
    ['exec:codemode:1','mcp_lookup','inner one','ok'],['exec:codemode:2','mcp_lookup','inner two','ok'],['exec','execute','script result','ok'],
    ['shell-call','shell',JSON.stringify([{type:'text',text:'out'},{type:'text',text:'Exited with code 1'}]),'error'],
  ]);
  await dispose();
});

test('OpenCode 2.x result text mirrors the host normalization',()=>{
  assert.deepEqual(openCodeResultText({content:'plain'}),{text:'plain',projectable:true});
  assert.deepEqual(openCodeResultText({content:[{type:'text',text:'one'}]}),{text:'one',projectable:true});
  assert.deepEqual(openCodeResultText({content:[],output:{a:1}}),{text:'{"a":1}',projectable:true});
  assert.deepEqual(openCodeResultText({output:'out'}),{text:'out',projectable:true});
  assert.equal(openCodeResultText({content:[{type:'file',uri:'x'}]} as any),undefined);
});

test('OpenCode 2.x hooks and tools fail open and setup survives a rejected registration',async()=>{
  const bridge={async request():Promise<never>{throw new Error('bridge down');},close(){}};
  const {context,hooks,tools}=fakeHost();
  const dispose=await createOpenCodeV2Plugin(context,{node:process.execPath,cli,storage:'/unused',bridge:bridge as any});
  await hooks['execute.after'](after('call','read','original'));
  const event=request(history('original'));const snapshot=JSON.stringify(event);
  await hooks['session.context'](event);await hooks['session.context'](event);
  assert.equal(JSON.stringify(event),snapshot);
  const result=JSON.parse((await tools[0].execute({},{sessionID:'session'})).content);
  assert.equal(result.originalsWereNotRemoved,true);assert.match(result.error,/bridge down/);
  await dispose();
  const broken=fakeHost(undefined,{transform:async()=>{throw new Error('registry closed');}});
  const disposeBroken=await createOpenCodeV2Plugin(broken.context,{node:process.execPath,cli,storage:'/unused',bridge:bridge as any});
  assert.deepEqual(Object.keys(broken.hooks),[]);await disposeBroken();
});

test('OpenCode 2.x cleanup disposes every registration and then the bridge exactly once',async()=>{
  let closes=0;const bridge={async request():Promise<any>{return {};},close(){closes++;}};
  const {context,disposed}=fakeHost();
  const dispose=await createOpenCodeV2Plugin(context,{node:process.execPath,cli,storage:'/unused',bridge:bridge as any});
  await dispose();await dispose();
  assert.deepEqual(disposed,['session.context','execute.after','tools']);assert.equal(closes,1);
});

test('real OpenCode 2.x plugin Node bridge archives per project, projects under pressure and recalls',async t=>{
  const {manager,dir,service}=await fixture(t);
  // A plugin instance for a subdirectory scopes to its project root, never the directory itself.
  const {context,hooks,tools}=fakeHost({directory:path.join(dir,'sub'),project:{directory:dir}});
  const dispose=await createOpenCodeV2Plugin(context,{node:process.execPath,cli,storage:dir});registerCleanup(manager,dispose);
  await hooks['execute.after'](after('call','read',[{type:'text',text:raw}]));
  const id=service.search().results[0].eventId;assert.ok(id);
  assert.equal((await manager.archive.fetchOriginal(id)).result,raw);
  manager.db.updateToolEvent(id,{state:'capsule',protected_until_turn:0});
  const first=request(history(raw));await hooks['session.context'](first);assert.equal(first.messages[2].content[0].result.value,raw);
  const second=request(history(raw));await hooks['session.context'](second);
  assert.match(second.messages[2].content[0].result.value,new RegExp(`^\\[CMM archive ${id}\\]`));
  const recalled=JSON.parse((await tools.find(t=>t.name==='context_recall').execute({eventId:id,limit:64000},{sessionID:'session'})).content);
  assert.equal(recalled.text,raw.slice(0,64000));
});

test('real OpenCode 2.x truncation metadata keeps partial evidence out of history projection',async t=>{
  const {manager,dir,service}=await fixture(t);
  const {context,hooks}=fakeHost({directory:dir,project:{directory:dir}});
  const dispose=await createOpenCodeV2Plugin(context,{node:process.execPath,cli,storage:dir});registerCleanup(manager,dispose);
  await hooks['execute.after'](after('call','read',[{type:'text',text:raw}],{truncated:true}));
  const id=service.lookup('session','call','read')!.eventId;
  assert.equal(service.explain(id).provenance.completeness,'partial');
  manager.db.updateToolEvent(id,{state:'capsule',protected_until_turn:0});
  for(let i=0;i<2;i++) {const event=request(history(raw));await hooks['session.context'](event);assert.equal(event.messages[2].content[0].result.value,raw);}
  assert.equal(manager.db.queryOne<{n:number}>('SELECT count(*) n FROM projection_cache')!.n,0);
});

test('global OpenCode 2.x setup writes one managed user plugin that loads and archives per project',async t=>{
  const root=temp(t);const config=path.join(root,'config');const storage=path.join(root,'storage');const ws=path.join(root,'ws');fs.mkdirSync(ws);
  const options={agent:'opencode' as const,workspace:ws,storage,cli,global:true,opencodeApi:2 as const,opencodeConfigDir:config};
  const changes=planSetup(options);const file=path.join(config,'plugins','context-memory-manager.ts');
  assert.deepEqual(changes.map(c=>c.file),[file]);
  const content=changes[0].after!;
  assert.match(content,/--managed-by-cmm/);assert.match(content,/opencode-v2\.js/);assert.match(content,/id: "context-memory-manager"/);
  assert.doesNotMatch(content,/@opencode-ai\/plugin/);assert.doesNotMatch(content,new RegExp(ws.replaceAll('\\','\\\\\\\\')),'the workspace comes from OpenCode at runtime');
  applySetup(changes);assert.equal(fs.readFileSync(file,'utf8'),content);
  // OpenCode type-strips the generated TypeScript; dropping the one annotation lets Node load it as-is.
  const module=path.join(root,'plugin.mjs');fs.writeFileSync(module,content.replace('(context: any)','(context)'));
  const plugin=(await import(pathToFileURL(module).href)).default;
  assert.equal(plugin.id,'context-memory-manager');assert.equal(typeof plugin.setup,'function');
  const {context,hooks}=fakeHost({directory:ws,project:{directory:ws}});
  const dispose=await plugin.setup(context);t.after(()=>dispose());
  await hooks['execute.after'](after('call','read','generated plugin evidence'));
  const listed=spawnSync(process.execPath,[cli,'events','--agent','opencode','--workspace',ws,'--storage',storage],{encoding:'utf8',timeout:20000});
  assert.equal(listed.status,0,listed.stderr);assert.equal(JSON.parse(listed.stdout)[0].tool_call_id,'call');
  await dispose();
  fs.writeFileSync(file,'// my plugin');assert.throws(()=>planSetup(options),/not CMM-managed/);assert.throws(()=>planUninstall(options),/not CMM-managed/);
  fs.writeFileSync(file,content);applySetup(planUninstall(options));assert.equal(fs.existsSync(file),false);
});

test('OpenCode setup keeps 1.x generation by default and rejects global installs it cannot honor',t=>{
  const root=temp(t);const base={workspace:root,storage:root,cli};
  const v1=planSetup({...base,agent:'opencode'})[0];
  assert.equal(v1.file,path.join(root,'.opencode','plugins','context-memory-manager.ts'));assert.match(v1.after!,/@opencode-ai\/plugin/);
  const v2=planSetup({...base,agent:'opencode',opencodeApi:2})[0];
  assert.equal(v2.file,v1.file);assert.match(v2.after!,/createOpenCodeV2Plugin/);
  assert.throws(()=>planSetup({...base,agent:'opencode',global:true}),/2\.x/);
  assert.throws(()=>planSetup({...base,agent:'claude',global:true}),/only to OpenCode/);
  assert.equal(openCodeConfigDir({OPENCODE_CONFIG_DIR:root}),path.resolve(root));
  assert.equal(openCodeConfigDir({XDG_CONFIG_HOME:root}),path.join(root,'opencode'));
});

test('CLI global OpenCode dry run targets the user config and rejects ambiguous flags',t=>{
  const root=temp(t);const env={...process.env,OPENCODE_CONFIG_DIR:path.join(root,'config')};
  const run=(args:string[])=>spawnSync(process.execPath,[cli,...args,'--workspace',root,'--storage',root],{encoding:'utf8',timeout:20000,env});
  const dry=run(['setup','opencode','--global','--dry-run']);assert.equal(dry.status,0,dry.stderr);
  const output=JSON.parse(dry.stdout);
  assert.deepEqual(output.writes.map((w:any)=>w.file),[path.join(root,'config','plugins','context-memory-manager.ts')]);
  assert.equal(output.opencode.pluginApi,2);assert.equal(output.opencode.source,'global');
  assert.equal(fs.existsSync(path.join(root,'config')),false);
  for(const args of [['setup','claude','--global'],['setup','all','--global'],['setup','opencode','--opencode-api','3'],['setup','opencode','--global','--opencode-api','1']]) {
    const result=run([...args,'--dry-run']);assert.equal(result.status,1,args.join(' '));
  }
});
