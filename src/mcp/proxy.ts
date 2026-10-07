import { randomUUID } from 'node:crypto';
import { MemoryService } from '../runtime/memory.js';
import { RpcClient } from '../runtime/rpc-client.js';
import { RpcError } from '../runtime/jsonl.js';
import { object, text, errorMessage } from '../util/validation.js';
import { capturedString } from '../integrations/hooks.js';
import { MEMORY_TOOLS, type ToolDefinition } from './tools.js';
import type { ToolBackend } from './server.js';

/** Preserves errors, structured results and non-text blocks verbatim. */
export function plainMcpText(value:unknown):string|undefined {
  if(!value || typeof value!=='object' || Array.isArray(value))return;
  const v=value as Record<string,unknown>;
  if(v.isError===true || v.structuredContent!==undefined || !Array.isArray(v.content) || !v.content.length)return;
  if(!v.content.every((p:unknown)=>p && typeof p==='object' && (p as any).type==='text' && typeof (p as any).text==='string'))return;
  // Annotations or extra content-block keys may have meaning. Do not discard them.
  if(v.content.some((p:object)=>Object.keys(p).some(k=>k!=='type' && k!=='text')))return;
  return v.content.map((p:any)=>p.text).join('\n');
}
export class MemoryProxy implements ToolBackend {
  private definitions=new Map<string,ToolDefinition>();
  private readonly sessionId=`proxy:${randomUUID()}`;
  private counter=0;
  constructor(readonly service:MemoryService,readonly upstream:RpcClient) {}
  async list():Promise<ToolDefinition[]> {
    const all:ToolDefinition[]=[];let cursor:string|undefined;const seen=new Set<string>();
    for(let page=0;page<100;page++) {
      const result=await this.upstream.request<{tools:ToolDefinition[];nextCursor?:string}>('tools/list',cursor ? {cursor} : {});
      if(!Array.isArray(result.tools))throw new Error('Upstream returned invalid tools/list');
      for(const tool of result.tools) {
        text(tool.name,'upstream tool name',200);object(tool.inputSchema,'upstream inputSchema');
        if(MEMORY_TOOLS.some(t=>t.name===tool.name) || all.some(t=>t.name===tool.name))throw new Error(`Duplicate/reserved upstream tool name: ${tool.name}`);
        all.push(tool);
      }
      if(result.nextCursor===undefined) {this.definitions=new Map(all.map(t=>[t.name,t]));return all;}
      cursor=text(result.nextCursor,'nextCursor');
      if(seen.has(cursor))throw new Error('Upstream repeated pagination cursor');seen.add(cursor);
    }
    throw new Error('Upstream tool listing exceeded 100 pages');
  }
  async call(name:string,args:unknown,signal:AbortSignal):Promise<unknown> {
    if(!this.definitions.has(name))await this.list();
    const definition=this.definitions.get(name);
    if(!definition)throw new RpcError(-32602,'Unknown upstream tool');
    signal.throwIfAborted();
    // Exactly one request: a lost response is never retried for potentially side-effecting tools.
    const result=await this.upstream.request('tools/call',{name,arguments:args},{timeoutMs:300000,signal});
    try {
      const status=(result as any)?.isError===true ? 'error' : 'ok';
      const saved=await this.service.capture({sessionId:this.sessionId,toolCallId:`call:${++this.counter}`,toolName:name,
        input:capturedString(args),result:capturedString(result),status,
        sideEffect:definition.annotations?.readOnlyHint!==true},'mcp:proxy');
      if(!saved.archived || !saved.eventId || definition.outputSchema!==undefined || definition.annotations?.readOnlyHint!==true)return result;
      const original=plainMcpText(result);if(original===undefined)return result;
      const p=await this.service.project(saved.eventId,original,'ingress',undefined,'mcp-text');
      return p.replaced ? {...result as object,content:[{type:'text',text:p.text}]} : result;
    } catch(error) {
      try {this.service.health('mcp:proxy',errorMessage(error));}catch{/* Keep upstream result even if diagnostics fail. */}
      return result;
    }
  }
}
