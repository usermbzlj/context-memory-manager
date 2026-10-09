import type { Readable, Writable } from 'node:stream';
import { runJsonlServer, RpcError } from './jsonl.js';
import { MemoryService, type Capture } from './memory.js';
import { object, text } from '../util/validation.js';
import { executeMemoryTool } from '../mcp/tools.js';

/** Private Node bridge so the OpenCode/Bun plugin never imports node:sqlite. */
export async function serveBridge(service:MemoryService,input:Readable=process.stdin,output:Writable=process.stdout) {
  await runJsonlServer({input,output,async handle(method,params,signal) {
    signal.throwIfAborted();
    const p=object(params ?? {},'params');
    switch(method) {
      case 'ping': return {ok:true};
      case 'lookup': return service.lookup(text(p.sessionId,'sessionId'),text(p.toolCallId,'toolCallId'),text(p.toolName,'toolName'));
      case 'observeProvenance': return service.observeProvenance(p as unknown as Parameters<MemoryService['observeProvenance']>[0]);
      case 'capture': return service.capture(p as unknown as Capture,'opencode');
      case 'captureBatch': {
        if(!Array.isArray(p.items) || p.items.length>1000)throw new RpcError(-32602,'Invalid capture batch');
        const result=[];
        for(const item of p.items) {signal.throwIfAborted();result.push(await service.capture(object(item,'capture') as unknown as Capture,'opencode'));}
        return result;
      }
      case 'transform': {
        const sessionId=text(p.sessionId,'sessionId');
        if(!Array.isArray(p.items))throw new RpcError(-32602,'items must be an array');
        return service.transform(sessionId,p.items,p.usage as any);
      }
      case 'tool': return executeMemoryTool(service,text(p.name,'name'),p.arguments,p.sessionId as string|undefined);
      default: throw new RpcError(-32601,'Unknown bridge method');
    }
  }});
}
