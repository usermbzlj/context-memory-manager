// This module is intentionally safe to load in Bun. SQLite lives in a Node child.
import path from 'node:path';
import { RpcClient } from '../runtime/rpc-client.js';
import { estimateTokens, isInternalTool } from '../descriptor.js';
import { stableJson, errorMessage } from '../util/validation.js';
import { MEMORY_TOOLS } from '../mcp/tools.js';

type SchemaNode={optional():SchemaNode;int():SchemaNode;min(n:number):SchemaNode;max(n:number):SchemaNode};
export type OpenCodeToolFactory=((definition:{description:string;args:Record<string,SchemaNode>;execute:(args:Record<string,unknown>,context:{sessionID:string;abort?:AbortSignal})=>Promise<string>})=>unknown) & {
  schema:{string():SchemaNode;number():SchemaNode;boolean():SchemaNode;enum(values:string[]):SchemaNode};
};
interface Part {type?:string;tool?:string;callID?:string;sessionID?:string;state?:{status?:string;input?:unknown;output?:string;error?:string;metadata?:Record<string,unknown>;attachments?:unknown[]}}
interface Message {info:{role?:string;sessionID?:string};parts:Part[]}
interface Bridge {request<T=any>(method:string,params?:unknown,opts?:{timeoutMs?:number;signal?:AbortSignal}):Promise<T>;close():void|Promise<void>}

export function openCodeWorkspace(input:{directory:string;worktree?:string}):string {
  const worktree=input.worktree;
  // OpenCode uses '/' as a sentinel for non-git/global projects. Never merge all
  // such projects into a root-scoped archive.
  return worktree && worktree!==path.parse(worktree).root && worktree!==path.win32.parse(worktree).root ? worktree : input.directory;
}

export async function createOpenCodePlugin(input:{directory:string;worktree?:string},options:{
  node:string;cli:string;storage:string;tool:OpenCodeToolFactory;
  /** Injected only by contract tests; never supplied by generated user config. */
  bridge?:Bridge;
}) {
  const workspace=openCodeWorkspace(input);
  let client:Bridge|undefined=options.bridge;
  let disposed=false;let disposal:Promise<void>|undefined;
  let warned=false;
  const cache=new Map<string,{eventId:string;partial:boolean}>();const windows=new Map<string,number>();
  const presented=new Set<string>();
  const key=(session:string,call:string)=>JSON.stringify([session,call]);
  const remember=(key:string,id:string,partial=false)=>{cache.set(key,{eventId:id,partial});if(cache.size>4096)cache.delete(cache.keys().next().value!);};
  const bridge=()=>{
    if(disposed)throw new Error('OpenCode CMM plugin is disposed');
    return client ??= new RpcClient(options.node,[options.cli,'bridge','--agent','opencode','--workspace',workspace,'--storage',options.storage],{cwd:workspace});
  };
  const warn=(error:unknown)=>{if(!warned){warned=true;process.stderr.write(`[cmm] Capture/projection unavailable; tool outputs unchanged. Run cmm doctor. ${errorMessage(error).slice(0,200)}\n`);}};
  const capture=async(session:string,call:string,tool:string,args:unknown,result:string,metadata?:Record<string,unknown>)=>{
    const k=key(session,call);
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
  };
  const tools:Record<string,unknown>={};
  for(const definition of MEMORY_TOOLS) {
    const args:Record<string,SchemaNode>={};
    for(const [name,property] of Object.entries(definition.inputSchema.properties) as [string,any][]) {
      const z=options.tool.schema;
      let node=property.enum ? z.enum(property.enum) : property.type==='integer' ? z.number().int() : property.type==='boolean' ? z.boolean() : z.string();
      if(property.minimum!==undefined)node=node.min(property.minimum);
      if(property.maximum!==undefined)node=node.max(property.maximum);
      if(property.maxLength!==undefined)node=node.max(property.maxLength);
      if(!(definition.inputSchema.required ?? []).includes(name))node=node.optional();
      args[name]=node;
    }
    tools[definition.name]=options.tool({description:definition.description,args,async execute(args,context) {
      try {return JSON.stringify(await bridge().request('tool',{name:definition.name,arguments:args,sessionId:context.sessionID},{signal:context.abort}));}
      catch(error) {warn(error);return JSON.stringify({error:errorMessage(error),originalsWereNotRemoved:true});}
    }});
  }
  return {
    tool:tools,
    dispose():Promise<void> {
      if(disposal)return disposal;
      disposed=true;const closing=client;client=undefined;
      return disposal=Promise.resolve().then(()=>closing?.close());
    },
    async 'chat.params'(data:{sessionID:string;model?:{limit?:{context?:number}}}) {
      const size=data.model?.limit?.context;
      if(typeof size==='number' && Number.isSafeInteger(size) && size>0)windows.set(data.sessionID,size);
      if(windows.size>128)windows.delete(windows.keys().next().value!);
    },
    async 'tool.execute.after'(data:{tool:string;sessionID:string;callID:string;args?:unknown},output:{output?:string;metadata?:Record<string,unknown>}) {
      // Some upstream MCP paths deliver raw CallToolResult here, not this output shape.
      // Those are observed later through completed message parts instead of guessed at.
      if(isInternalTool(data.tool) || typeof output.output!=='string')return;
      try {await capture(data.sessionID,data.callID,data.tool,data.args,output.output,output.metadata);}catch(error){warn(error);}
    },
    async 'experimental.chat.messages.transform'(_data:unknown,output:{messages:Message[]}) {
      if(!Array.isArray(output.messages))return;
      const groups=new Map<string,{eventId:string;output:string;part:Part}[]>();
      // Only completed text tool results. No user text, assistant prose, tool inputs,
      // pending/error states, attachments, permissions or transcript files are edited.
      for(const message of output.messages) {
        if(message.info?.role!=='assistant' || !Array.isArray(message.parts))continue;
        for(const part of message.parts) {
          const session=part.sessionID ?? message.info.sessionID;
          if(part.type!=='tool' || !part.tool || isInternalTool(part.tool) || !part.callID || !session ||
             part.state?.status!=='completed' || typeof part.state.output!=='string' || part.state.attachments?.length)continue;
          try {
            const id=await capture(session,part.callID,part.tool,part.state.input,part.state.output,part.state.metadata);
            const group=groups.get(session) ?? [];group.push({eventId:id,output:part.state.output,part});groups.set(session,group);
          } catch(error){warn(error);}
        }
      }
      for(const [session,items] of groups) {
        if(items.length>1000){warn(new Error('History exceeds the 1000-output projection bound'));continue;}
        try {
          const matching=output.messages.filter(m=>m.info?.sessionID===session);
          const messages=matching.length ? matching : output.messages;
          const usage={source:'estimated',usedTokens:estimateTokens(JSON.stringify(messages)),...(windows.has(session)?{contextWindow:windows.get(session)}:{})};
          const result=await bridge().request<{projections:{eventId:string;text:string;replaced:boolean}[]}>('transform',{
            sessionId:session,items:items.filter(item=>presented.has(item.eventId) || item.output.startsWith(`[CMM archive ${item.eventId}]`)).map(({eventId,output})=>({eventId,output})),usage,
          });
          const projected=new Map(result.projections.filter(p=>p.replaced).map(p=>[p.eventId,p.text]));
          for(const item of items) {
            const seen=presented.has(item.eventId) || item.output.startsWith(`[CMM archive ${item.eventId}]`);
            // A batch can contain many tools. Turn age alone does not prove that the
            // model has received a newly captured output even once.
            if(seen && projected.has(item.eventId) && item.part.state?.output===item.output)
              item.part.state.output=projected.get(item.eventId)!;
            presented.add(item.eventId);
            if(presented.size>4096)presented.delete(presented.values().next().value!);
          }
        } catch(error){warn(error);}
      }
    },
  };
}
