#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig, updateConfig, defaultStoragePath, redactConfig } from './config.js';
import { errorMessage, object, terminalSafe } from './util/validation.js';
import { planSetup, planUninstall, applySetup, MissingHostConfig, type AgentTarget, type FileChange } from './integrations/setup.js';
import type { ContextManager as Manager } from './core/context-manager.js';

import { VERSION } from './version.js';
export { VERSION };
const HELP=`Context Memory Manager ${VERSION}
Keep the evidence. Shrink the context. Recall the original.

Usage: cmm <command> [arguments] [options]

Start here:
  demo                         Offline capture -> compress -> exact recall proof
  setup <agent|all> --dry-run   Preview installation paths (no writes)
  setup <agent|all>             Merge project config; back up replaced files
  uninstall <agent|all>         Remove only managed config; keep all archives
  doctor                       Check local runtime, archive and integration health

Memory (scoped by --agent and --workspace):
  capture --file <event.json>   Import {sessionId,toolCallId?,toolName,input,result,status?}
  search [query]               Search payload chunks; --cursor for the next page
  import-rtk --database PATH --hash HASH  Copy one RTK recall entry (read-only source)
  recall <eventId>             Read a verified page; --offset N --limit N
  recall <eventId> --out FILE   Export the complete captured field (no overwrite)
  pin <eventId> | unpin <id>    Protect/release an event
  explain <eventId>            Show provenance, decisions, chain and pins
  status                       Capture health and actual projection receipts
  verify | reindex             Verify hashes / rebuild full-content chunk index
  tidy --session <host-id>     Evaluate context pressure for one captured session
  gc --yes                    Apply explicitly configured retention caps globally
  config show                 Show config with credentials redacted
  config set <key> <JSON>      Validate and atomically save a setting
  dashboard                   Start the authenticated local browser dashboard

Agent processes (stdout is protocol-only):
  serve                        Tools-only memory MCP stdio server
  proxy -- <command> [args]    Wrap a stdio MCP tool server; no tool-call retries
  hook <claude|codex|kimi>      Native capture hook (fails open)
  bridge                       Private Node bridge used by OpenCode

Diagnostics: sessions | events | chains | capsules | scores | recalls | providers | stats

Options:
  --agent NAME                Default: cli. Use the same agent as capture.
  --workspace PATH            Default: current directory
  --storage PATH              Default: CMM_STORAGE or ~/.context-memory-manager
  --port N --open              Dashboard port (0 chooses a free port), open browser
  --shared                    Explicit cross-agent reads within this workspace
  --file PATH                 Capture input; otherwise read stdin
  --field input|result        Recall field (default result)
  --find TEXT                 Recall around a literal match, starting at --offset
  --cursor VALUE              Continue the same search query/scope
  --database PATH --hash HASH  Explicit RTK recall database and 12-hex reference
  --limit N --offset N         Search/page bounds; recall defaults to 12000 chars
  --session ID                Host session ID for tidy or restored recall
  --restore                   Promote a complete single-page recall to HOT
  --out PATH                  Exact UTF-8 export; fails if the file exists
  --used-tokens N              Optional current usage for tidy
  --context-window N           Optional context window for tidy
  --dry-run --json --help --version

Agent support is intentionally honest:
OpenCode: pressure-batched historical text projection. Ingress compression is opt-in.
Codex/Kimi native hooks: capture + recall only. MCP proxy: eligible text results.
Installing only the memory MCP server does NOT capture native tools.
No account, API key, network, vector database or paid model needed by default.
`;
const options={
  storage:{type:'string'},workspace:{type:'string'},agent:{type:'string'},session:{type:'string'},
  database:{type:'string'},hash:{type:'string'},find:{type:'string'},cursor:{type:'string'},
  port:{type:'string'},open:{type:'boolean'},
  file:{type:'string'},out:{type:'string'},field:{type:'string'},limit:{type:'string'},offset:{type:'string'},
  'used-tokens':{type:'string'},'context-window':{type:'string'},
  json:{type:'boolean'},shared:{type:'boolean'},restore:{type:'boolean'},'dry-run':{type:'boolean'},
  yes:{type:'boolean'},'managed-by-cmm':{type:'boolean'},help:{type:'boolean',short:'h'},version:{type:'boolean',short:'v'},
} as const;
type Flags=ReturnType<typeof argumentsFor>['values'];
function argumentsFor(argv:string[]) {
  const split=argv.indexOf('--');
  const parsed=parseArgs({args:split<0?argv:argv.slice(0,split),options,allowPositionals:true,strict:true});
  return {...parsed,passthrough:split<0?[]:argv.slice(split+1)};
}
function numeric(value:string|undefined,fallback:number):number {
  if(value===undefined)return fallback;
  if(!/^\d+$/.test(value))throw new Error('Expected a nonnegative integer, got '+value);
  const n=Number(value);if(!Number.isSafeInteger(n))throw new Error('Integer is too large');return n;
}
function emit(value:unknown) {process.stdout.write(JSON.stringify(value,null,2)+'\n');}
function required(value:string|undefined,name:string):string {if(!value)throw new Error(`${name} is required; run cmm --help`);return value;}
function agentTarget(value:string|undefined):AgentTarget {
  if(!value || !['claude','codex','kimi','opencode'].includes(value))throw new Error('Agent must be claude, codex, kimi or opencode');
  return value as AgentTarget;
}
async function readInput(file?:string):Promise<string> {
  const max=32*1024*1024;
  if(file) {if(fs.statSync(file).size>max)throw new Error('Input exceeds 32 MiB');return new TextDecoder('utf-8',{fatal:true}).decode(fs.readFileSync(file));}
  const chunks:Buffer[]=[];let size=0;
  for await(const chunk of process.stdin) {const b=Buffer.from(chunk);size+=b.length;if(size>max)throw new Error('Input exceeds 32 MiB');chunks.push(b);}
  return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
}
function writeExport(file:string,value:string):void {
  const fd=fs.openSync(path.resolve(file),'wx',0o600);
  try {fs.writeFileSync(fd,value,'utf8');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
async function configSet(storage:string,key:string,raw:string) {
  if(key==='storage.path')throw new Error('Select storage with --storage; do not move data by editing config');
  return updateConfig(storage,cfg=>{
  const parts=key.split('.');let target=cfg as unknown as Record<string,any>;
  for(const p of parts.slice(0,-1)) {
    if(['__proto__','constructor','prototype'].includes(p) || !Object.hasOwn(target,p) || !target[p] || typeof target[p]!=='object' || Array.isArray(target[p]))throw new Error('Unknown config path');
    target=target[p];
  }
  const last=parts.at(-1)!;
  if(['__proto__','constructor','prototype'].includes(last) || !Object.hasOwn(target,last))throw new Error('Unknown config key');
  target[last]=JSON.parse(raw);return cfg as unknown as Record<string,unknown>;
  });
}
function diagnostics(manager:Manager,scope:{agent:string;workspaceId:string;shared?:boolean},cmd:string,limit:number) {
  if(limit<1 || limit>200)throw new Error('Diagnostic limit must be 1..200');
  const filter=scope.shared?'workspace_id=?':'workspace_id=? AND agent=?';
  const values=scope.shared?[scope.workspaceId]:[scope.workspaceId,scope.agent];
  if(cmd==='events')return manager.db.queryAll(`SELECT id,tool_call_id,session_id,tool_name,status,state,created_at,result_bytes FROM tool_events WHERE ${filter} ORDER BY created_at DESC,id LIMIT ?`,[...values,limit]);
  if(cmd==='sessions')return manager.db.queryAll(`SELECT * FROM sessions WHERE ${filter} ORDER BY created_at DESC LIMIT ?`,[...values,limit]);
  if(cmd==='chains')return manager.db.queryAll(`SELECT * FROM chains WHERE session_id IN (SELECT id FROM sessions WHERE ${filter}) ORDER BY updated_at DESC LIMIT ?`,[...values,limit]);
  if(cmd==='scores')return manager.db.queryAll(`SELECT * FROM decisions WHERE event_id IN (SELECT id FROM tool_events WHERE ${filter}) ORDER BY id DESC LIMIT ?`,[...values,limit]);
  if(cmd==='capsules')return manager.db.queryAll(`SELECT * FROM capsules WHERE id IN (SELECT capsule_id FROM tool_events WHERE ${filter}) ORDER BY created_at DESC LIMIT ?`,[...values,limit]);
  if(cmd==='recalls')return manager.db.queryAll(`SELECT id,tool_call_id,recalled_count,last_recalled_at FROM tool_events WHERE ${filter} AND recalled_count>0 ORDER BY last_recalled_at DESC LIMIT ?`,[...values,limit]);
  if(cmd==='providers')return {scope:'global provider ledger; costs are not measured billing',calls:manager.db.queryAll('SELECT provider,model,purpose,tokens_in,tokens_out,ok,created_at FROM provider_calls ORDER BY id DESC LIMIT ?',[limit])};
  if(cmd==='stats')return {scope:'global core estimates, not current occupancy or billing',...manager.getStats()};
  throw new Error('Unknown diagnostic');
}
export async function main(argv=process.argv.slice(2)):Promise<void> {
  const {values:flags,positionals,passthrough}=argumentsFor(argv);
  const [cmd='help',...rest]=positionals;
  if(flags.version || cmd==='version') {process.stdout.write(VERSION+'\n');return;}
  if(flags.help || cmd==='help') {process.stdout.write(HELP);return;}
  const [major,minor]=process.versions.node.split('.').map(Number);
  if(major<22 || major===22 && minor<13)throw new Error('Node.js >=22.13 is required. OpenCode runs this core in a Node child, not Bun.');
  const workspace=path.resolve(flags.workspace ?? process.cwd()),storage=path.resolve(flags.storage ?? defaultStoragePath());
  const cli=fileURLToPath(import.meta.url);
  if(passthrough.length && cmd!=='proxy')throw new Error('Arguments after -- are only accepted for proxy');
  if(cmd==='setup' || cmd==='uninstall') {
    const all=rest[0]==='all',targets=all?['claude','codex','kimi','opencode'] as const:[agentTarget(rest[0])];
    const changes:FileChange[]=[],skipped:{agent:AgentTarget;reason:string}[]=[];
    for(const agent of targets) {
      try {changes.push(...(cmd==='setup'?planSetup:planUninstall)({agent,workspace,storage,cli}));}
      catch(error) {if(!all || !(error instanceof MissingHostConfig))throw error;skipped.push({agent,reason:error.message});}
    }
    const extra=skipped.length?{skipped}:{};
    if(flags['dry-run'])emit({dryRun:true,writes:changes.filter(c=>c.before!==c.after).map(c=>({file:c.file,reason:c.reason,backup:c.before!==null})),...extra,note:'No files written. Existing secrets are not printed.'});
    else emit({...applySetup(changes),...extra,next:cmd==='uninstall'?'Restart the agent. Archives are untouched.':'Restart the agent and approve trusted hooks/MCP if asked. Re-run setup after moving CMM.'});
    return;
  }
  if(cmd==='launch')throw new Error('cmm launch kimi was removed: Kimi Code 2.x has no per-launch config flags. Run cmm setup kimi instead.');
  if(cmd==='config') {
    const cfg=loadConfig(storage);
    if(rest[0]==='set') {const saved=await configSet(storage,required(rest[1],'config key'),required(rest[2],'JSON value'));emit({saved:true,config:redactConfig(saved)});}
    else if(rest[0]===undefined || rest[0]==='show')emit(redactConfig(cfg));else throw new Error('Use config show or config set <key> <JSON>');
    return;
  }
  if(cmd==='import-rtk' && flags['dry-run']) {
    const {readRtkEvidence}=await import('./integrations/rtk.js');
    const data=readRtkEvidence({database:required(flags.database,'--database'),hash:required(flags.hash,'--hash'),workspace});
    emit({dryRun:true,writes:false,source:data.metadata});return;
  }
  if(cmd==='demo') {const {runDemo}=await import('./demo.js');await runDemo();return;}
  if(cmd==='dashboard') {
    const {startDashboard}=await import('./dashboard/server.js');
    const dashboard=await startDashboard({storage,workspace,agent:flags.agent ?? 'codex',port:numeric(flags.port,0),open:flags.open});
    emit({dashboard:dashboard.url,launchUrl:dashboard.launchUrl,scope:'selected storage',listen:'loopback',note:'Open launchUrl once; keep it private. Ctrl+C stops the panel.'});
    await new Promise<void>(resolve=>{
      let closing=false;
      const close=()=>{if(closing)return;closing=true;void dashboard.close().then(resolve,()=>{process.exitCode=1;resolve();});};
      process.once('SIGINT',close);process.once('SIGTERM',close);
      process.stdin.on('end',close);process.stdin.resume();
    });
    return;
  }
  const commands=['hook','serve','proxy','bridge','capture','import-rtk','search','recall','pin','unpin','status','explain','verify','reindex','tidy','gc','doctor','sessions','events','chains','capsules','scores','recalls','providers','stats'];
  if(!commands.includes(cmd))throw new Error(`Unknown command: ${cmd}. Run cmm --help.`);
  const {ContextManager}=await import('./core/context-manager.js');
  const {MemoryService}=await import('./runtime/memory.js');
  let manager:Manager|undefined;
  let shutdown:()=>void|Promise<void>=()=>{};
  let stopping=false;
  const signal=()=>{
    if(stopping)return;
    stopping=true;
    void (async()=>{
      try {await shutdown();}
      finally {try {manager?.close();} finally {process.exit(130);}}
    })();
  };
  const nativeHook=cmd==='hook';
  try {
    if(nativeHook) {
      const agent=agentTarget(rest[0]);if(agent==='opencode')throw new Error('OpenCode uses its plugin, not hook stdin');
      const {parseHook,executeHook}=await import('./integrations/hooks.js');
      const parsed=parseHook(agent,JSON.parse(await readInput(flags.file)));if(!parsed)return;
      // Descendant working directories are normal; never mix an unrelated workspace.
      const {normalizeWorkspaceId}=await import('./storage/archive.js');
      const relative=path.relative(normalizeWorkspaceId(workspace),normalizeWorkspaceId(parsed.cwd));
      if(relative==='..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative)) {
        // Kimi hooks are user-level and run in every project; other projects are not an error.
        if(agent==='kimi')return;
        throw new Error('Hook cwd is outside the configured workspace');
      }
      manager=ContextManager.open(storage,undefined,{component:'hook',persistent:false});
      const service=new MemoryService(manager,{agent,workspaceId:workspace});
      const response=await executeHook(service,agent,parsed);if(response!==undefined)emit(response);
      return;
    }
    if(cmd==='gc' && !flags.yes)throw new Error('GC can delete cold originals across this entire storage. Review caps, then explicitly pass --yes.');
    if(cmd==='proxy' && !passthrough.length)throw new Error('Use cmm proxy -- <MCP server command> [args]');
    manager=ContextManager.open(storage,undefined,{component:cmd==='bridge'?'bridge':'manager',persistent:['bridge','serve','proxy'].includes(cmd)});
    const service=new MemoryService(manager,{agent:flags.agent ?? 'cli',workspaceId:workspace,shared:flags.shared});
    if(flags.shared && ['capture','import-rtk','tidy','bridge','proxy'].includes(cmd))throw new Error('--shared is for explicit archive access, not capture or host projection');
    if(['serve','bridge','proxy'].includes(cmd)) {
      process.once('SIGINT',signal);process.once('SIGTERM',signal);
      if(cmd==='bridge') {const {serveBridge}=await import('./runtime/bridge.js');await serveBridge(service);}
      else {
        const {serveMemory}=await import('./mcp/server.js');
        if(cmd==='serve')await serveMemory(service);
        else {
          const {RpcClient}=await import('./runtime/rpc-client.js');const {MemoryProxy}=await import('./mcp/proxy.js');
          const client=new RpcClient(passthrough[0],passthrough.slice(1),{cwd:workspace});shutdown=()=>client.close();
          await client.initialize();await serveMemory(service,{backend:new MemoryProxy(service,client)});
        }
      }
      return;
    }
    switch(cmd) {
      case 'capture': {
        const payload=object(JSON.parse(await readInput(flags.file)),'event');
        const saved=await service.capture(payload as any,'cli');emit(saved);if(!saved.archived)process.exitCode=1;break;
      }
      case 'import-rtk': {
        const {importRtkEvidence}=await import('./integrations/rtk.js');
        const result=await importRtkEvidence(service,{database:required(flags.database,'--database'),hash:required(flags.hash,'--hash'),workspace,sessionId:flags.session});
        emit(result);if(!result.archived)process.exitCode=1;break;
      }
      case 'search': emit(service.search(rest.join(' '),numeric(flags.limit,10),undefined,flags.cursor));break;
      case 'status': emit(service.status());break;
      case 'explain': emit(service.explain(required(rest[0],'eventId')));break;
      case 'pin': case 'unpin': emit(await service.pin(required(rest[0],'eventId'),cmd==='pin'));break;
      case 'recall': {
        const id=required(rest[0],'eventId');const field=flags.field ?? 'result';if(field!=='input' && field!=='result')throw new Error('field must be input or result');
        if(flags.out) {
          if(flags.restore || flags.offset || flags.limit || flags.find)throw new Error('--out exports a full field; do not combine with --restore, --offset, --limit or --find');
          service.event(id);const original=await manager.archive.fetchOriginal(id);writeExport(flags.out,original[field]);emit({file:path.resolve(flags.out),eventId:id,field,bytes:Buffer.byteLength(original[field]),verified:true,provenance:service.explain(id).provenance,notice:'Exact captured field bytes; completeness is separate from hash verification.'});
        } else emit(await service.recall(id,{field,offset:numeric(flags.offset,0),limit:numeric(flags.limit,12000),restore:flags.restore,sessionId:flags.session,find:flags.find}));
        break;
      }
      case 'verify': case 'reindex': {const result=await service.verify(cmd==='reindex');emit(result);if(result.failed)process.exitCode=1;break;}
      case 'tidy': {
        const sid=service.hostSessionId(required(flags.session,'--session'));
        if(flags['used-tokens'])manager.reportHostUsage(sid,{usedTokens:numeric(flags['used-tokens'],0),contextWindow:numeric(flags['context-window'],manager.config.integration.contextWindow)});
        emit(await manager.maybeTidy(sid));break;
      }
      case 'gc': emit({scope:'entire storage',...(await manager.gc()),freedBytesMeaning:'Logical event payload bytes, not deduplicated physical disk reclamation'});break;
      case 'doctor': {
        const check=await service.verify();
        const installation=planSetup({agent:agentTarget(flags.agent ?? 'opencode'),workspace,storage,cli}).map(c=>({file:c.file,installed:c.before===c.after,exists:c.before!==null}));
        emit({ok:check.failed===0,node:process.version,platform:process.platform,storage,sqlite:manager.db.queryOne('SELECT sqlite_version() AS version'),archive:check,installation,status:service.status(),limits:['This diagnoses local files and capture observations, not a live end-to-end agent certification.','MCP-only setup does not observe native tools.','Unknown result shapes, unarchived outputs and protected events stay unchanged.']});
        if(check.failed)process.exitCode=1;break;
      }
      default: emit(diagnostics(manager,service.scope,cmd,numeric(flags.limit,20)));
    }
  } catch(error) {
    if(nativeHook) {process.stderr.write('[cmm] Hook failed open; original tool result retained. '+terminalSafe(errorMessage(error)).slice(0,600)+'\n');return;}
    throw error;
  } finally {
    try {await shutdown();}
    finally {process.off('SIGINT',signal);process.off('SIGTERM',signal);manager?.close();}
  }
}
// Importable for contract tests; executing the published bin runs exactly once.
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main().catch(error=>{
    process.stderr.write('[cmm] '+terminalSafe(errorMessage(error)).slice(0,1000)+'\n');
    // Malformed hook arguments also fail open. Never block the host's successful tool.
    process.exitCode=process.argv.slice(2).includes('hook')?0:1;
  });
}
