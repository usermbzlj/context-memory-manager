// Shared by the OpenCode 1.x and 2.x adapters. Safe to load in Bun: SQLite lives in a Node child.
import path from 'node:path';
import { RpcClient } from '../runtime/rpc-client.js';
import { stableJson, errorMessage } from '../util/validation.js';

export interface Bridge {request<T=any>(method:string,params?:unknown,opts?:{timeoutMs?:number;signal?:AbortSignal}):Promise<T>;close():void|Promise<void>}
export interface OpenCodeBridgeOptions {
  node:string;cli:string;storage:string;
  /** Injected only by contract tests; never supplied by generated user config. */
  bridge?:Bridge;
}
export interface HistoryUsage {source:'estimated';usedTokens:number;contextWindow?:number}

export function openCodeWorkspace(input:{directory:string;worktree?:string}):string {
  const worktree=input.worktree;
  // OpenCode uses '/' as a sentinel for non-git/global projects. Never merge all
  // such projects into a root-scoped archive.
  return worktree && worktree!==path.parse(worktree).root && worktree!==path.win32.parse(worktree).root ? worktree : input.directory;
}

export function openCodeBridge(workspace:string,options:OpenCodeBridgeOptions) {
  let client:Bridge|undefined=options.bridge;
  let disposed=false;let disposal:Promise<void>|undefined;
  let warned=false;
  const cache=new Map<string,{eventId:string;partial:boolean}>();
  const presented=new Set<string>();
  // The tool name is part of the key: OpenCode 2.x code-mode calls share their parent's call ID.
  const key=(session:string,call:string,tool:string)=>JSON.stringify([session,call,tool]);
  const remember=(key:string,id:string,partial=false)=>{cache.set(key,{eventId:id,partial});if(cache.size>4096)cache.delete(cache.keys().next().value!);};
  const bridge=()=>{
    if(disposed)throw new Error('OpenCode CMM plugin is disposed');
    return client ??= new RpcClient(options.node,[options.cli,'bridge','--agent','opencode','--workspace',workspace,'--storage',options.storage],{cwd:workspace});
  };
  const warn=(error:unknown)=>{if(!warned){warned=true;process.stderr.write(`[cmm] Capture/projection unavailable; tool outputs unchanged. Run cmm doctor. ${errorMessage(error).slice(0,200)}\n`);}};
  const seen=(item:{eventId:string;output:string})=>presented.has(item.eventId) || item.output.startsWith(`[CMM archive ${item.eventId}]`);
  return {
    warn,
    async capture(session:string,call:string,tool:string,args:unknown,result:string,metadata?:Record<string,unknown>):Promise<string> {
      const k=key(session,call,tool);
      const partial=metadata?.truncated===true;
      const provenance={version:1,origin:'tool-observation',captureStage:'host-result',completeness:'partial',
        notes:['OpenCode reported metadata.truncated=true; omitted source content was not captured.']};
      const observe=async(id:string)=>{
        await bridge().request('observeProvenance',{sessionId:session,toolCallId:call,toolName:tool,output:result,provenance});
        remember(k,id,true);return id;
      };
      const cached=cache.get(k);
      if(cached)return partial && !cached.partial ? observe(cached.eventId) : cached.eventId;
      if(result.startsWith('[CMM archive ')) {
        const prior=await bridge().request<{eventId:string}|null>('lookup',{sessionId:session,toolCallId:call,toolName:tool});
        if(prior && result.startsWith(`[CMM archive ${prior.eventId}]`)) {
          if(partial)return observe(prior.eventId);
          remember(k,prior.eventId);return prior.eventId;
        }
      }
      const response=await bridge().request<{archived:boolean;eventId:string|null;error?:string}>('capture',{
        sessionId:session,toolCallId:call,toolName:tool,input:typeof args==='string'?args:stableJson(args ?? {}),result,
        status:metadata && [metadata.exit,metadata.exitCode,metadata.exit_code].some(n=>typeof n==='number' && n!==0)?'error':'ok',
        ...(partial ? {provenance} : {}),
      });
      if(!response.archived || !response.eventId)throw new Error(response.error ?? 'Capture did not produce a durable event');
      remember(k,response.eventId,partial);return response.eventId;
    },
    /** Our recall tools answer with JSON text and never throw into the host. */
    async callTool(name:string,args:unknown,session:string,signal?:AbortSignal):Promise<string> {
      try {return JSON.stringify(await bridge().request('tool',{name,arguments:args,sessionId:session},{signal}));}
      catch(error) {warn(error);return JSON.stringify({error:errorMessage(error),originalsWereNotRemoved:true});}
    },
    /**
     * Projected text for outputs the model has already received at least once. Every item is
     * marked presented afterwards; a failed or oversized batch changes and marks nothing.
     */
    async project(session:string,items:{eventId:string;output:string}[],usage:HistoryUsage):Promise<Map<string,string>> {
      if(items.length>1000){warn(new Error('History exceeds the 1000-output projection bound'));return new Map();}
      try {
        const result=await bridge().request<{projections:{eventId:string;text:string;replaced:boolean}[]}>('transform',{
          sessionId:session,items:items.filter(seen).map(({eventId,output})=>({eventId,output})),usage,
        });
        const projected=new Map(result.projections.filter(p=>p.replaced).map(p=>[p.eventId,p.text]));
        const replacements=new Map<string,string>();
        // A batch can contain many tools. Turn age alone does not prove that the
        // model has received a newly captured output even once.
        for(const item of items)if(seen(item) && projected.has(item.eventId))replacements.set(item.eventId,projected.get(item.eventId)!);
        for(const item of items) {
          presented.add(item.eventId);
          if(presented.size>4096)presented.delete(presented.values().next().value!);
        }
        return replacements;
      } catch(error) {warn(error);return new Map();}
    },
    dispose():Promise<void> {
      if(disposal)return disposal;
      disposed=true;const closing=client;client=undefined;
      return disposal=Promise.resolve().then(()=>closing?.close());
    },
  };
}
