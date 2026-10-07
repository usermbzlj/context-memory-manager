import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { atomicWrite } from '../util/atomic.js';
import { object } from '../util/validation.js';

export type AgentTarget='claude'|'codex'|'kimi'|'opencode';
export interface SetupOptions {agent:AgentTarget;workspace:string;storage:string;cli:string;node?:string;platform?:NodeJS.Platform}
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
export function hookCommand(options:SetupOptions):string {
  return [options.node ?? process.execPath,options.cli,'hook',options.agent,'--workspace',options.workspace,'--storage',options.storage,'--managed-by-cmm']
    .map(v=>shellQuote(v,options.platform)).join(' ');
}
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
      return {...group,hooks:group.hooks.filter((handler:any)=>typeof handler.command!=='string' || !handler.command.includes('--managed-by-cmm'))};
    }).filter(group=>group.hooks.length);
    hooks[event]=[...cleaned,{hooks:[{type:'command',command:hookCommand(options),timeout:15}]}];
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
export function planSetup(options:SetupOptions):FileChange[] {
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
    const file=path.join(o.workspace,'.opencode','plugins','context-memory-manager.ts');
    const module=pathToFileURL(path.join(path.dirname(o.cli),'integrations','opencode.js')).href;
    const content=`// Generated by CMM --managed-by-cmm. Re-run setup after moving its installation.\nimport { tool } from '@opencode-ai/plugin';\nimport { createOpenCodePlugin } from ${JSON.stringify(module)};\nexport default async (input: any) => createOpenCodePlugin(input, {\n  node: ${JSON.stringify(o.node ?? process.execPath)},\n  cli: ${JSON.stringify(o.cli)},\n  storage: ${JSON.stringify(o.storage)},\n  tool,\n});\n`;
    add(file,b=>{if(b!==null && !b.includes('--managed-by-cmm'))throw new Error('Existing plugin is not CMM-managed');return content;},'Node-backed native OpenCode history projection and recall tools');
  } else {
    const file=path.join(o.workspace,'.kimi','cmm.mcp.json');
    add(file,b=>mergeMcp(b,file,o),'Use with cmm launch kimi, which adds capture hooks without changing your global config');
  }
  return changes;
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

/** A temporary sibling preserves the source config's relative-path base. */
export function prepareKimiLaunch(options:Omit<SetupOptions,'agent'> & {configFile?:string}):{args:string[];files:string[];cleanup:()=>void} {
  const o={...options,agent:'kimi' as const};
  const source=path.resolve(options.configFile ?? path.join(os.homedir(),'.kimi','config.toml'));
  const before=read(source) ?? '';
  const isJson=source.endsWith('.json') || before.trimStart().startsWith('{');
  let after:string;
  if(isJson) {
    const data=parse(before || '{}',source);
    const hooks=data.hooks ?? [];if(!Array.isArray(hooks))throw new Error('Kimi hooks must be an array');
    data.hooks=[...hooks.filter((h:any)=>typeof h.command!=='string' || !h.command.includes('--managed-by-cmm')),
      ...['PostToolUse','PostToolUseFailure'].map(event=>({event,command:hookCommand(o),timeout:15}))];after=json(data);
  } else {
    if(/^\s*hooks\s*=/m.test(before))throw new Error('Cannot safely extend an inline Kimi hooks array; use [[hooks]] or a JSON config file');
    const body=['PostToolUse','PostToolUseFailure'].map(event=>`[[hooks]]\nevent = ${JSON.stringify(event)}\ncommand = ${JSON.stringify(hookCommand(o))}\ntimeout = 15`).join('\n\n');
    after=replaceManagedBlock(before,body);
  }
  const base=path.join(path.dirname(source),`.cmm-launch-${randomUUID()}`);
  const config=base+(isJson?'.json':'.toml'),mcp=base+'.mcp.json';
  const files=[config,mcp];
  const cleanup=()=>{for(const file of files)try{fs.unlinkSync(file);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')process.stderr.write(`[cmm] Could not remove temporary config: ${file}\n`);}};
  const defaultMcp=path.join(os.homedir(),'.kimi','mcp.json');
  const existing=read(defaultMcp);
  if(existing && (parse(existing,defaultMcp).mcpServers ?? {})[SERVER_NAME])throw new Error('A global Kimi context_memory server already exists; remove/rename it before a scoped launch');
  try {atomicWrite(config,after);atomicWrite(mcp,json({mcpServers:{[SERVER_NAME]:mcpDefinition(o)}}));}catch(error){cleanup();throw error;}
  const args=['--config-file',config,...(existing?['--mcp-config-file',defaultMcp]:[]),'--mcp-config-file',mcp];
  return {args,files,cleanup};
}

/** Remove only our marked configuration. Archives and unrelated agent settings remain. */
export function planUninstall(options:SetupOptions):FileChange[] {
  const changes:FileChange[]=[];
  const edit=(file:string,change:(before:string)=>string|null,reason:string)=>{
    const before=read(file);if(before===null)return;changes.push({file,before,after:change(before),reason});
  };
  const workspace=path.resolve(options.workspace);
  if(options.agent==='opencode') {
    edit(path.join(workspace,'.opencode','plugins','context-memory-manager.ts'),before=>{
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
    const file=path.join(workspace,'.kimi','cmm.mcp.json');edit(file,b=>removeMcp(b,file),'Remove the project memory MCP entry; stop using cmm launch kimi to disable capture');return changes;
  }
  const hooks=path.join(workspace,options.agent==='claude'?'.claude':'.codex',options.agent==='claude'?'settings.local.json':'hooks.json');
  edit(hooks,b=>{
    const data=parse(b,hooks);if(!data.hooks)return b;const existing=object(data.hooks,'hooks');let changed=false;
    for(const event of ['PostToolUse','PostToolUseFailure']) {
      if(!existing[event])continue;if(!Array.isArray(existing[event]))throw new Error('Invalid hook groups; no changes made');
      const groups=(existing[event] as any[]).map(group=>{
        if(!Array.isArray(group.hooks))throw new Error('Invalid hook handlers; no changes made');
        const handlers=group.hooks.filter((h:any)=>typeof h.command!=='string' || !h.command.includes('--managed-by-cmm'));
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
