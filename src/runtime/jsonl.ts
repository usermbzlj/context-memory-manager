import type { Readable, Writable } from 'node:stream';
import { errorMessage } from '../util/validation.js';

export type RpcId = string | number;
export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {super(message);this.code=code;this.data=data;}
}
export type RpcHandler = (method:string, params:unknown, signal:AbortSignal) => Promise<unknown> | unknown;

export async function writeJson(output: Writable, value: unknown): Promise<void> {
  const data=JSON.stringify(value)+'\n';
  if (output.destroyed || output.writableEnded) throw new Error('Protocol output is closed');
  if(Buffer.byteLength(data)>32*1024*1024) throw new RpcError(-32000,'Outgoing JSONL frame exceeds 32 MiB');
  await new Promise<void>((resolve,reject) => {
    const onError=(error:Error)=>reject(error);
    output.once('error',onError);
    output.write(data,error => {
      // Keep the listener through the following tick: Writable emits error after its callback.
      setImmediate(()=>output.off('error',onError));
      if(error)reject(error);else resolve();
    });
  });
}

/** UTF-8 framing with a hard byte bound. No readline buffer can grow without limit. */
export async function* jsonLines(input: Readable, maxBytes=32*1024*1024): AsyncGenerator<string> {
  let decoder=new TextDecoder('utf-8',{fatal:true});let buffer='';let bytes=0;
  for await (const raw of input) {
    const chunk=typeof raw === 'string' ? Buffer.from(raw) : raw as Buffer;
    let start=0;
    for (let i=0;i<chunk.length;i++) {
      if (chunk[i] !== 10) continue;
      bytes += i-start;
      if (bytes>maxBytes) throw new RpcError(-32000,'JSONL frame exceeds 32 MiB; keep original tool output');
      buffer+=decoder.decode(chunk.subarray(start,i),{stream:true});
      buffer+=decoder.decode();
      if (buffer.endsWith('\r')) buffer=buffer.slice(0,-1);
      if (buffer.trim()) yield buffer;
      buffer='';bytes=0;start=i+1;decoder=new TextDecoder('utf-8',{fatal:true});
    }
    bytes+=chunk.length-start;
    if(bytes>maxBytes) throw new RpcError(-32000,'JSONL frame exceeds 32 MiB; keep original tool output');
    buffer+=decoder.decode(chunk.subarray(start),{stream:true});
  }
  buffer+=decoder.decode();
  if(buffer.trim()) yield buffer;
}

export async function runJsonlServer(options: {
  input:Readable;output:Writable;handle:RpcHandler;
  notify?: (method:string,params:unknown) => void;
  maxInflight?:number;
}):Promise<void> {
  const pending=new Map<RpcId,{controller:AbortController;job:Promise<void>}>();
  const sendError=(id:RpcId|null,code:number,message:string,data?:unknown) =>
    writeJson(options.output,{jsonrpc:'2.0',id,error:{code,message:message.slice(0,1000),...(data===undefined ? {} : {data})}});
  const deliver=async(line:string) => {
    let raw:unknown;
    try {raw=JSON.parse(line);} catch {await sendError(null,-32700,'Parse error');return;}
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {await sendError(null,-32600,'Invalid Request');return;}
    const message=raw as Record<string,unknown>;
    const id=message.id;
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string' ||
        (id !== undefined && !(typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id))))) {
      await sendError(null,-32600,'Invalid Request');return;
    }
    if (id === undefined) {
      if (message.method === 'notifications/cancelled') {
        const requestId=(message.params as {requestId?:RpcId}|undefined)?.requestId;
        if (requestId !== undefined) pending.get(requestId)?.controller.abort();
      } else options.notify?.(message.method,message.params);
      return;
    }
    if (pending.has(id)) {await sendError(id,-32600,'Duplicate in-flight request id');return;}
    if (pending.size >= (options.maxInflight ?? 8)) {await sendError(id,-32000,'Too many in-flight requests; wait for existing requests');return;}
    const controller=new AbortController();
    // Deferring one microtask ensures even synchronous handlers are tracked before they finish.
    const job=Promise.resolve().then(async () => {
      try {
        const result=await options.handle(message.method as string,message.params,controller.signal);
        if (controller.signal.aborted) throw new RpcError(-32800,'Request cancelled; completed side effects are not rolled back');
        await writeJson(options.output,{jsonrpc:'2.0',id,result:result ?? {}});
      } catch (error) {
        await sendError(id,error instanceof RpcError ? error.code : -32603,errorMessage(error),error instanceof RpcError ? error.data : undefined).catch(() => {});
      } finally {pending.delete(id);}
    });
    pending.set(id,{controller,job});
  };
  try {for await (const line of jsonLines(options.input)) await deliver(line);}
  catch(error) {await sendError(null,error instanceof RpcError ? error.code : -32603,errorMessage(error)).catch(() => {});}
  finally {await Promise.allSettled([...pending.values()].map(p => p.job));}
}
