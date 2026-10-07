import type { ChildProcess } from 'node:child_process';
import { spawnCommand } from '../util/spawn.js';
import { jsonLines, RpcError, writeJson, type RpcId } from './jsonl.js';
import { errorMessage } from '../util/validation.js';
import { observeChild } from '../util/child-lifecycle.js';
import { LEGACY_PROTOCOLS } from '../mcp/protocol.js';
import { VERSION } from '../version.js';

/** Private bridge / tools-only upstream client. Never retries a tool call. */
export class RpcClient {
  private next=0;
  private closed=false;
  private readonly lifecycle:ReturnType<typeof observeChild>;
  private shutdown:Promise<void>|undefined;
  private readonly pending=new Map<RpcId,{resolve:(value:any)=>void;reject:(error:Error)=>void;cleanup:()=>void}>();
  readonly process:ChildProcess;
  constructor(command:string,args:string[],options:{cwd?:string;env?:NodeJS.ProcessEnv;stderr?:'inherit'|'ignore'}={}) {
    this.process=spawnCommand(command,args,{cwd:options.cwd,env:options.env,stdio:['pipe','pipe',options.stderr ?? 'inherit'],windowsHide:true});
    // close follows process exit and closed stdio handles. Waiting only for kill()
    // or stdin.end() can leave SQLite/files open while a caller removes storage.
    this.lifecycle=observeChild(this.process);
    this.process.on('error',e=>this.fail(e));
    this.process.on('exit',(code,signal)=>this.fail(new Error(`Child exited (${code ?? signal})`)));
    this.process.stdin?.on('error',e=>this.fail(e));
    void this.read().catch(e=>this.fail(e instanceof Error ? e : new Error(errorMessage(e))));
  }
  private fail(error:Error) {
    if(this.closed)return;
    this.closed=true;
    for(const p of this.pending.values()) {p.cleanup();p.reject(error);}
    this.pending.clear();
    this.beginShutdown();
  }
  private beginShutdown():Promise<void> {
    if(this.shutdown)return this.shutdown;
    this.shutdown=this.lifecycle.shutdown().then(()=>{});
    // Protocol failure also initiates shutdown. Legacy callers may deliberately
    // ignore close(); awaiting it still observes a failure to terminate.
    void this.shutdown.catch(()=>{});
    return this.shutdown;
  }
  private async read() {
    if(!this.process.stdout) throw new Error('Child stdout not available');
    for await(const line of jsonLines(this.process.stdout)) {
      const m=JSON.parse(line) as {jsonrpc?:string;id?:RpcId;method?:string;result?:unknown;error?:{code:number;message:string}};
      if(m.jsonrpc!=='2.0') throw new Error('Child wrote non-JSON-RPC data to stdout');
      if(m.method) {
        if(m.id !== undefined) await writeJson(this.process.stdin!,m.method==='ping' ? {jsonrpc:'2.0',id:m.id,result:{}} :
          {jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'This tools-only client does not support server-initiated requests'}});
        continue;
      }
      const p=m.id===undefined ? undefined : this.pending.get(m.id);
      if(!p) continue;
      p.cleanup();this.pending.delete(m.id!);
      if(m.error) p.reject(new RpcError(m.error.code,m.error.message));else p.resolve(m.result);
    }
    if(!this.closed) this.fail(new Error('Child stdout closed'));
  }
  request<T=unknown>(method:string,params:unknown={},options:{timeoutMs?:number;signal?:AbortSignal}={}):Promise<T> {
    if(this.closed || !this.process.stdin) return Promise.reject(new Error('Child protocol is closed'));
    if(options.signal?.aborted) return Promise.reject(new RpcError(-32800,'Cancelled'));
    const id=++this.next;
    return new Promise<T>((resolve,reject)=> {
      const cancel=()=>{
        const p=this.pending.get(id);if(!p)return;
        p.cleanup();this.pending.delete(id);
        void this.notify('notifications/cancelled',{requestId:id,reason:'caller cancelled or timed out'}).catch(()=>{});
        reject(new RpcError(-32800,'Request cancelled or timed out; tool execution was not retried'));
      };
      const timer=setTimeout(cancel,options.timeoutMs ?? 30000);
      const cleanup=()=>{clearTimeout(timer);options.signal?.removeEventListener('abort',cancel);};
      options.signal?.addEventListener('abort',cancel,{once:true});
      this.pending.set(id,{resolve,reject,cleanup});
      void writeJson(this.process.stdin!,{jsonrpc:'2.0',id,method,params}).catch(error=>{
        cleanup();this.pending.delete(id);reject(error);
      });
    });
  }
  async notify(method:string,params?:unknown) {
    if(this.closed || !this.process.stdin) return;
    await writeJson(this.process.stdin,{jsonrpc:'2.0',method,...(params===undefined ? {} : {params})});
  }
  async initialize() {
    const result=await this.request<{protocolVersion:string;capabilities:Record<string,unknown>}>('initialize',{
      protocolVersion:LEGACY_PROTOCOLS.at(-1),capabilities:{},clientInfo:{name:'context-memory-manager',version:VERSION},
    });
    if(!LEGACY_PROTOCOLS.includes(result.protocolVersion)) {
      await this.close();throw new Error(`Upstream negotiated unsupported protocol ${result.protocolVersion}`);
    }
    await this.notify('notifications/initialized');
    return result;
  }
  close():Promise<void> {
    if(!this.closed) this.fail(new Error('Client closed'));
    return this.beginShutdown();
  }
}
