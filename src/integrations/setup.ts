import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { atomicWrite } from '../util/atomic.js';
import { object } from '../util/validation.js';
import { spawnCommand } from '../util/spawn.js';

export type AgentTarget='claude'|'codex'|'kimi'|'opencode';
export interface SetupOptions {
  agent:AgentTarget;workspace:string;storage:string;cli:string;node?:string;platform?:NodeJS.Platform;kimiHome?:string;
  /** OpenCode plugin API generation. Default 1 (the `@opencode-ai/plugin` function export). */
  opencodeApi?:1|2;
  /** OpenCode 2.x only: install into the user config so every project gets its own archive scope. */
  global?:boolean;
  opencodeConfigDir?:string;
}
export interface FileChange {file:string;before:string|null;after:string|null;reason:string}
const BEGIN='# BEGIN CMM MANAGED';const END='# END CMM MANAGED';
export const SERVER_NAME='context_memory';
const read=(file:string)=>{try{return fs.readFileSync(file,'utf8');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}};
const json=(value:unknown)=>JSON.stringify(value,null,2)+'\n';
const parse=(value:string|null,file:string):Record<string,any>=>value===null?{}:object(JSON.parse(value.replace(/^\uFEFF/,'')),file);
export function shellQuote(value:string,platform:NodeJS.Platform=process.platform):string {
  if(/[\r\n\0]/.test(value))throw new Error('Newlines/NUL are not valid in generated hook commands');
  if(platform==='win32') {
    if(/["%!^&|<>]/.test(value))throw new Error('Unsupported shell characters in Windows install path; choose a path without command metacharacters');
    return '"'+value.replaceAll('\\','/')+'"';
  }
  return "'"+value.replaceAll("'","'\\''")+"'";
}
function hookArgv(options:SetupOptions):string[] {
  return [options.node ?? process.execPath,options.cli,'hook',options.agent,'--workspace',options.workspace,'--storage',options.storage,'--managed-by-cmm'];
}
export function hookCommand(options:SetupOptions):string {
  if(options.agent==='codex' && (options.platform ?? process.platform)==='win32') {
    // Codex uses the Windows session's PowerShell. Quoted executable strings need
    // the call operator, and literal strings must not expand $variables/backticks.
    // PowerShell also treats U+2018/2019/201A/201B as single-quote delimiters.
    const quote=(value:string)=>{
      if(/[\r\n\0]/.test(value))throw new Error('Newlines/NUL are not valid in generated hook commands');
      return "'"+value.replace(/['\u2018\u2019\u201A\u201B]/g,q=>q+q)+"'";
    };
    return '& '+hookArgv(options).map(quote).join(' ');
  }
  return hookArgv(options).map(v=>shellQuote(v,options.platform)).join(' ');
}
/** Claude exec form: no shell, so Git Bash/PowerShell quoting rules never apply. */
function hookHandler(options:SetupOptions):Record<string,unknown> {
  if(options.agent!=='claude')return {type:'command',command:hookCommand(options),timeout:15};
  const [command,...args]=hookArgv(options);
  return {type:'command',command,args,timeout:15};
}
const managedHandler=(handler:any)=>(typeof handler?.command==='string' && handler.command.includes('--managed-by-cmm')) ||
  (Array.isArray(handler?.args) && handler.args.includes('--managed-by-cmm'));
export function mcpDefinition(options:SetupOptions) {
  return {command:options.node ?? process.execPath,args:[options.cli,'serve','--agent',options.agent,'--workspace',options.workspace,'--storage',options.storage,'--managed-by-cmm']};
}
function mergeMcp(before:string|null,file:string,options:SetupOptions):string {
  const data=parse(before,file);const servers=data.mcpServers===undefined?{}:object(data.mcpServers,'mcpServers');
  const current=servers[SERVER_NAME];
  if(current && !Array.isArray((current as any).args))throw new Error(`Existing ${SERVER_NAME} server is not CMM-managed; refusing to overwrite`);
  if(current && !(current as any).args.includes('--managed-by-cmm'))throw new Error(`Existing ${SERVER_NAME} server is not CMM-managed; refusing to overwrite`);
  servers[SERVER_NAME]=mcpDefinition(options);data.mcpServers=servers;return json(data);
}
function mergeHooks(before:string|null,file:string,options:SetupOptions):string {
  const data=parse(before,file);const hooks=data.hooks===undefined?{}:object(data.hooks,'hooks');
  const events=options.agent==='codex'?['PostToolUse']:['PostToolUse','PostToolUseFailure'];
  for(const event of events) {
    const groups=hooks[event] ?? [];if(!Array.isArray(groups))throw new Error(`Invalid ${event} hook config`);
    const cleaned=groups.map((value:unknown)=>{
      const group=object(value,'hook group');if(!Array.isArray(group.hooks))throw new Error('Invalid hook handlers');
      return {...group,hooks:group.hooks.filter((handler:unknown)=>!managedHandler(handler))};
    }).filter(group=>group.hooks.length);
    hooks[event]=[...cleaned,{hooks:[hookHandler(options)]}];
  }
  data.hooks=hooks;return json(data);
}
export function replaceManagedBlock(before:string,body:string):string {
  const starts=before.split(BEGIN).length-1,ends=before.split(END).length-1;
  if(starts!==ends || starts>1)throw new Error('Ambiguous CMM managed block; refusing to edit config');
  const block=BEGIN+'\n'+body.trimEnd()+'\n'+END+'\n';
  if(starts===1) {
    const pattern=/^# BEGIN CMM MANAGED\r?\n[\s\S]*?^# END CMM MANAGED\r?\n?/m;
    if(!pattern.test(before))throw new Error('Malformed CMM managed block; refusing to edit config');
    return before.replace(pattern,block);
  }
  return before+(before && !before.endsWith('\n')?'\n':'')+(before?'\n':'')+block;
}
/** OpenCode 2.x user config directory, resolved as OpenCode does. */
export function openCodeConfigDir(env:NodeJS.ProcessEnv=process.env):string {
  if(env.OPENCODE_CONFIG_DIR)return path.resolve(env.OPENCODE_CONFIG_DIR);
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(),'.config'),'opencode');
}
function openCodePluginFile(options:SetupOptions):string {
  if(options.global && options.opencodeApi!==2)throw new Error('Global OpenCode installation needs the OpenCode 2.x plugin API (--opencode-api 2)');
  return options.global ? path.join(options.opencodeConfigDir ?? openCodeConfigDir(),'plugins','context-memory-manager.ts') :
    path.join(path.resolve(options.workspace),'.opencode','plugins','context-memory-manager.ts');
}
/** Major plugin API of the installed OpenCode CLI, or undefined when it cannot be determined. */
export function detectOpenCodeApi(timeoutMs=10000):Promise<1|2|undefined> {
  return new Promise(resolve=>{
    let output='';let done=false;
    const finish=(value:1|2|undefined)=>{if(!done){done=true;clearTimeout(timer);resolve(value);}};
    let child:ReturnType<typeof spawnCommand>;
    try {child=spawnCommand('opencode',['--version'],{stdio:['ignore','pipe','ignore'],windowsHide:true});}
    catch {resolve(undefined);return;}
    const timer=setTimeout(()=>{child.kill();finish(undefined);},timeoutMs);
    child.stdout?.on('data',chunk=>{output+=chunk;if(output.length>4096)child.kill();});
    child.on('error',()=>finish(undefined));
    child.on('close',code=>{
      const major=Number(/(?:^|\s)v?(\d+)\.\d+\.\d+/.exec(output)?.[1]);
      finish(code===0 ? major===1 ? 1 : major>=2 ? 2 : undefined : undefined);
    });
  });
}
export function planSetup(options:SetupOptions):FileChange[] {
  if(options.global && options.agent!=='opencode')throw new Error('--global applies only to OpenCode');
  const o={...options,workspace:path.resolve(options.workspace),storage:path.resolve(options.storage),cli:path.resolve(options.cli)};
  const changes:FileChange[]=[];
  const add=(file:string,after:(before:string|null)=>string,reason:string)=>{const before=read(file);changes.push({file,before,after:after(before),reason});};
  if(o.agent==='claude') {
    const hooks=path.join(o.workspace,'.claude','settings.local.json');
    add(hooks,b=>mergeHooks(b,hooks,o),'Capture completed tools; shape-safe large Bash stdout replacement');
    const mcp=path.join(o.workspace,'.mcp.json');add(mcp,b=>mergeMcp(b,mcp,o),'Search, recall, pin and status tools');
  } else if(o.agent==='codex') {
    const hooks=path.join(o.workspace,'.codex','hooks.json');add(hooks,b=>mergeHooks(b,hooks,o),'Capture-only PostToolUse; no blocking or output rewriting');
    const config=path.join(o.workspace,'.codex','config.toml');
    add(config,b=>{
      const before=b ?? '';
      const without=before.replace(/^# BEGIN CMM MANAGED\r?\n[\s\S]*?^# END CMM MANAGED\r?\n?/m,'');
      if(/^\s*\[\s*(?:"mcp_servers"|'mcp_servers'|mcp_servers)\s*\.\s*(?:"context_memory"|'context_memory'|context_memory)(?:\s*\]|\s*\.)/m.test(without) ||
         /^\s*(?:"context_memory"|'context_memory'|context_memory|"mcp_servers"|'mcp_servers'|mcp_servers)\s*=/m.test(without))
        throw new Error('Existing context_memory TOML settings are not CMM-managed; refusing to overwrite');
      const server=mcpDefinition(o);
      return replaceManagedBlock(before,`[mcp_servers.${SERVER_NAME}]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}\nstartup_timeout_sec = 15\ntool_timeout_sec = 60\n`);
    },'Project-scoped stdio memory server; existing TOML is retained');
  } else if(o.agent==='opencode') {
    const file=openCodePluginFile(o);
    const v2=o.opencodeApi===2;
    const module=pathToFileURL(path.join(path.dirname(o.cli),'integrations',v2?'opencode-v2.js':'opencode.js')).href;
    const bridge=`  node: ${JSON.stringify(o.node ?? process.execPath)},\n  cli: ${JSON.stringify(o.cli)},\n  storage: ${JSON.stringify(o.storage)},\n`;
    const content=v2
      ? `// Generated by CMM --managed-by-cmm. Re-run setup after moving its installation.\nimport { createOpenCodeV2Plugin } from ${JSON.stringify(module)};\nexport default {\n  id: "context-memory-manager",\n  setup: (context: any) => createOpenCodeV2Plugin(context, {\n${bridge.replace(/^(?=.)/gm,'  ')}  }),\n};\n`
      : `// Generated by CMM --managed-by-cmm. Re-run setup after moving its installation.\nimport { tool } from '@opencode-ai/plugin';\nimport { createOpenCodePlugin } from ${JSON.stringify(module)};\nexport default async (input: any) => createOpenCodePlugin(input, {\n${bridge}  tool,\n});\n`;
    add(file,b=>{if(b!==null && !b.includes('--managed-by-cmm'))throw new Error('Existing plugin is not CMM-managed');return content;},
      o.global ? 'User-level OpenCode 2.x plugin: archive, history projection and recall tools, scoped per project' :
        `Node-backed native OpenCode ${v2?'2.x':'1.x'} history projection and recall tools`);
  } else {
    const config=path.join(o.kimiHome ?? kimiCodeHome(),'config.toml');
    if(read(config)===null)throw new MissingHostConfig(`Kimi Code config not found: ${config}. Run kimi once, or set KIMI_CODE_HOME to its data directory.`);
    add(config,b=>upsertKimiHooks(b ?? '',o),'Capture-only [[hooks]] for this workspace in the user-level Kimi Code config; other projects are skipped');
    const mcp=path.join(o.workspace,'.kimi-code','mcp.json');add(mcp,b=>mergeMcp(b,mcp,o),'Project memory MCP server; approve workspace trust in Kimi Code');
  }
  return changes;
}

/** A host prerequisite is absent; `setup all` reports it instead of failing every agent. */
export class MissingHostConfig extends Error {}

/** Kimi Code reads hooks only from `$KIMI_CODE_HOME/config.toml` (default `~/.kimi-code`). */
export function kimiCodeHome(env:NodeJS.ProcessEnv=process.env):string {
  return env.KIMI_CODE_HOME ? path.resolve(env.KIMI_CODE_HOME) : path.join(os.homedir(),'.kimi-code');
}

const KIMI_EVENTS=['PostToolUse','PostToolUseFailure'];
const quoted=(values:string[],platform?:NodeJS.Platform)=>values.map(v=>shellQuote(v,platform)).join(' ');

/** Our surgical table editor cannot safely interpret TOML multiline values. */
function requireSingleLineTomlStrings(source:string):void {
  let quote:'"'|"'"|undefined;
  for(let i=0;i<source.length;i++) {
    const ch=source[i];
    if(quote) {
      if(ch==='\n' || ch==='\r')throw new Error('Unterminated single-line TOML string; refusing to edit Kimi config');
      if(quote==='"' && ch==='\\') {i++;continue;}
      if(ch===quote)quote=undefined;
      continue;
    }
    if(ch==='#') {const end=source.indexOf('\n',i);if(end<0)break;i=end;continue;}
    if(ch==='"' || ch==="'") {
      if(source.slice(i,i+3)===ch.repeat(3))throw new Error('Kimi config contains TOML multiline strings; edit CMM hooks manually instead of letting CMM rewrite this config');
      quote=ch;
    }
  }
  if(quote)throw new Error('Unterminated single-line TOML string; refusing to edit Kimi config');
}

/** Split TOML into top-level header segments. Values in our [[hooks]] tables are single-line. */
function tomlSegments(source:string):{header:string;text:string}[] {
  const segments:{header:string;text:string}[]=[{header:'',text:''}];
  for(const line of source.split(/(?<=\n)/)) {
    if(/^\s*\[/.test(line))segments.push({header:line.trim(),text:line});
    else segments[segments.length-1].text+=line;
  }
  return segments;
}
function tomlCommand(segment:string):string|undefined {
  const match=/^\s*command\s*=\s*(.+?)\s*$/m.exec(segment);if(!match)return undefined;
  const value=match[1];
  if(value.startsWith("'"))return value.endsWith("'")?value.slice(1,-1):undefined;
  try {const parsed=JSON.parse(value);return typeof parsed==='string'?parsed:undefined;}catch{return undefined;}
}
/**
 * Identify CMM tables by their command, not by comments: Kimi may rewrite its
 * own config and is not required to keep comments.
 */
function replaceKimiHooks(before:string,workspace:string,platform:NodeJS.Platform|undefined,tables:string):string {
  requireSingleLineTomlStrings(before);
  if(/^\s*hooks\s*=/m.test(before) || /^\s*\[\s*hooks\s*\]/m.test(before))throw new Error('Kimi hooks are not in [[hooks]] table form; edit them manually instead of letting CMM rewrite them');
  const owner=quoted(['--workspace',workspace],platform),agent=quoted(['hook','kimi'],platform);
  const segments=tomlSegments(before);
  const ours=segments.map(segment=>{
    if(!/^\[\[\s*hooks\s*\]\]\s*(?:#.*)?$/.test(segment.header))return false;
    const command=tomlCommand(segment.text);
    return Boolean(command?.includes('--managed-by-cmm') && command.includes(agent) && command.includes(owner));
  });
  const kept=segments.filter((_segment,i)=>!ours[i]).map(segment=>segment.text).join('');
  if(kept.includes('--managed-by-cmm') && kept.includes(JSON.stringify(owner).slice(1,-1)))
    throw new Error('A CMM Kimi hook for this workspace is in an unrecognized form; remove it manually');
  const first=ours.indexOf(true);
  if(first<0)return tables?kept+(kept && !kept.endsWith('\n')?'\n':'')+tables:kept;
  // Re-running setup keeps the existing position so unchanged settings stay byte-identical.
  return segments.map((segment,i)=>i===first?tables:ours[i]?'':segment.text).join('');
}
export function upsertKimiHooks(before:string,options:SetupOptions):string {
  const tables=KIMI_EVENTS.map(event=>`[[hooks]]\n# Managed by Context Memory Manager for ${options.workspace}; remove with cmm uninstall kimi\nevent = ${JSON.stringify(event)}\ncommand = ${JSON.stringify(hookCommand(options))}\ntimeout = 15\n`).join('');
  return replaceKimiHooks(before,options.workspace,options.platform,tables);
}
export function applySetup(changes:FileChange[]):{written:string[];backups:string[]} {
  const changed=changes.filter(c=>c.before!==c.after);
  for(const c of changed)if(read(c.file)!==c.before)throw new Error(`Config changed since planning: ${c.file}`);
  const backups:string[]=[];const applied:FileChange[]=[];
  try {
    for(const c of changed) {
      if(c.before!==null) {const backup=c.file+`.cmm-backup-${Date.now()}-${randomUUID().slice(0,8)}`;atomicWrite(backup,c.before);backups.push(backup);}
      // Recheck immediately before every write, not only before a multi-file operation.
      if(read(c.file)!==c.before)throw new Error(`Concurrent config edit: ${c.file}`);
      if(c.after===null)fs.unlinkSync(c.file);else atomicWrite(c.file,c.after);applied.push(c);
    }
  } catch(error) {
    for(const c of applied.reverse()) {
      if(read(c.file)!==c.after)continue; // Do not overwrite a concurrent user edit while rolling back.
      if(c.before===null)fs.unlinkSync(c.file);else atomicWrite(c.file,c.before);
    }
    throw error;
  }
  return {written:applied.map(c=>c.file),backups};
}

/** Remove only our marked configuration. Archives and unrelated agent settings remain. */
export function planUninstall(options:SetupOptions):FileChange[] {
  const changes:FileChange[]=[];
  const edit=(file:string,change:(before:string)=>string|null,reason:string)=>{
    const before=read(file);if(before===null)return;changes.push({file,before,after:change(before),reason});
  };
  if(options.global && options.agent!=='opencode')throw new Error('--global applies only to OpenCode');
  const workspace=path.resolve(options.workspace);
  if(options.agent==='opencode') {
    edit(openCodePluginFile(options.global ? {...options,opencodeApi:2} : options),before=>{
      if(!before.includes('--managed-by-cmm'))throw new Error('Plugin is not CMM-managed; refusing to remove it');return null;
    },'Remove only the CMM-managed OpenCode plugin');
    return changes;
  }
  const removeMcp=(before:string,file:string)=>{
    const data=parse(before,file);if(!data.mcpServers)return before;
    const servers=object(data.mcpServers,'mcpServers'),current=servers[SERVER_NAME] as any;
    if(!current || !Array.isArray(current.args) || !current.args.includes('--managed-by-cmm'))return before;
    delete servers[SERVER_NAME];return json(data);
  };
  if(options.agent==='kimi') {
    const config=path.join(options.kimiHome ?? kimiCodeHome(),'config.toml');
    edit(config,b=>replaceKimiHooks(b,workspace,options.platform,''),'Remove only this workspace\'s CMM [[hooks]] from the Kimi Code config');
    for(const file of [path.join(workspace,'.kimi-code','mcp.json'),path.join(workspace,'.kimi','cmm.mcp.json')])
      edit(file,b=>removeMcp(b,file),'Remove only the CMM-managed project MCP entry');
    return changes;
  }
  const hooks=path.join(workspace,options.agent==='claude'?'.claude':'.codex',options.agent==='claude'?'settings.local.json':'hooks.json');
  edit(hooks,b=>{
    const data=parse(b,hooks);if(!data.hooks)return b;const existing=object(data.hooks,'hooks');let changed=false;
    for(const event of ['PostToolUse','PostToolUseFailure']) {
      if(!existing[event])continue;if(!Array.isArray(existing[event]))throw new Error('Invalid hook groups; no changes made');
      const groups=(existing[event] as any[]).map(group=>{
        if(!Array.isArray(group.hooks))throw new Error('Invalid hook handlers; no changes made');
        const handlers=group.hooks.filter((h:unknown)=>!managedHandler(h));
        if(handlers.length!==group.hooks.length)changed=true;return {...group,hooks:handlers};
      }).filter(group=>group.hooks.length);
      if(groups.length)existing[event]=groups;else delete existing[event];
    }
    return changed?json(data):b;
  },'Remove only marked CMM native hooks');
  if(options.agent==='claude') {
    const file=path.join(workspace,'.mcp.json');edit(file,b=>removeMcp(b,file),'Remove only the CMM-managed MCP server');
  }else {
    edit(path.join(workspace,'.codex','config.toml'),b=>{
      if(!b.includes(BEGIN) && !b.includes(END))return b;
      replaceManagedBlock(b,''); // Validate exactly one line-aligned block before removing.
      return b.replace(/^# BEGIN CMM MANAGED\r?\n[\s\S]*?^# END CMM MANAGED\r?\n?/m,'');
    },'Remove the marked CMM TOML block, retaining all unrelated settings');
  }
  return changes;
}
