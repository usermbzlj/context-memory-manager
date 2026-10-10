// OpenCode 2.x adapter (Plugin.define setup API). Safe to load in Bun: SQLite lives in a Node child.
import { estimateTokens, isInternalTool } from '../descriptor.js';
import { MEMORY_TOOLS } from '../mcp/tools.js';
import { openCodeBridge, openCodeWorkspace, type OpenCodeBridgeOptions } from './opencode-core.js';

type Content={type:string;text?:string};
interface ToolResult {output?:unknown;content?:string|readonly Content[];metadata?:Record<string,unknown>}
interface AfterEvent {tool:string;sessionID:string;id:string;input:unknown;status:'completed'|'error';result?:ToolResult}
interface Part {type?:string;id?:string;name?:string;input?:unknown;providerExecuted?:boolean;result?:{type?:string;value?:unknown}}
interface Message {role?:string;content?:readonly Part[]}
interface ContextEvent {sessionID:string;model?:{providerID?:string;id?:string};system?:unknown;messages:Message[]}
interface Registration {dispose():Promise<void>}
interface ToolEditor {add(tool:{name:string;description:string;input:unknown;options?:{codemode?:boolean};
  execute(input:unknown,context:{sessionID:string;signal?:AbortSignal}):Promise<{content:string}>}):void}
/** The subset of the OpenCode 2.x promise plugin context this adapter uses. */
export interface OpenCodeV2Context {
  location:{directory:string;project?:{directory?:string}};
  tool:{
    transform(callback:(editor:ToolEditor)=>void):Promise<Registration>;
    hook(name:'execute.after',callback:(event:AfterEvent)=>Promise<void>):Promise<Registration>;
    list():Promise<readonly {id:string;options?:{codemode?:boolean}}[]>;
  };
  session:{hook(name:'context',callback:(event:ContextEvent)=>Promise<void>):Promise<Registration>};
  model:{list():Promise<unknown>};
}

const stringify=(value:unknown)=>{
  if(typeof value==='string')return value;
  try {return JSON.stringify(value) ?? String(value);} catch {return String(value);}
};
/**
 * The archived form of a completed result. Only `text` results can be projected later; they
 * are exactly what OpenCode sends as a single-text tool result. Text-only multi-part results
 * are archived as their JSON parts. Results carrying files are left alone.
 */
export function openCodeResultText(result:ToolResult|undefined):{text:string;projectable:boolean}|undefined {
  const content=result?.content;
  if(typeof content==='string')return {text:content,projectable:true};
  if(Array.isArray(content) && content.length>0) {
    if(!content.every(part=>part?.type==='text' && typeof part.text==='string'))return undefined;
    return content.length===1 ? {text:content[0].text!,projectable:true} : {text:JSON.stringify(content),projectable:false};
  }
  return {text:stringify(result?.output),projectable:true};
}

export async function createOpenCodeV2Plugin(context:OpenCodeV2Context,options:OpenCodeBridgeOptions):Promise<()=>Promise<void>> {
  const workspace=openCodeWorkspace({directory:context.location.directory,worktree:context.location.project?.directory});
  const core=openCodeBridge(workspace,options);
  const registrations:Registration[]=[];
  const windows=new Map<string,number>();
  const inner=new Map<string,number>();
  const contextWindow=async(model:ContextEvent['model']):Promise<number|undefined>=>{
    if(!model?.providerID || !model.id)return undefined;
    const key=`${model.providerID}/${model.id}`;
    if(windows.has(key))return windows.get(key);
    try {
      const listed=await context.model.list() as any;
      const models:any[]=Array.isArray(listed) ? listed : Array.isArray(listed?.data) ? listed.data : [];
      const found=models.find(m=>m?.providerID===model.providerID && m?.id===model.id);
      const size=found?.limit?.input ?? found?.limit?.context;
      if(typeof size==='number' && Number.isSafeInteger(size) && size>0) {
        windows.set(key,size);if(windows.size>128)windows.delete(windows.keys().next().value!);
        return size;
      }
    } catch(error) {core.warn(error);}
    return undefined;
  };
  // Code-mode calls run inside the `execute` tool under its call ID; only `execute` returns
  // a model-visible result, so their outputs are archived as evidence under derived IDs.
  let direct=new Set<string>();
  const codeModeCall=async(event:AfterEvent):Promise<string>=>{
    if(event.tool==='execute' || direct.has(event.tool))return event.id;
    try {direct=new Set((await context.tool.list()).filter(tool=>tool.options?.codemode===false).map(tool=>tool.id));}
    catch(error) {core.warn(error);return event.id;}
    if(direct.has(event.tool))return event.id;
    const key=JSON.stringify([event.sessionID,event.id]);
    const n=(inner.get(key) ?? 0)+1;inner.set(key,n);if(inner.size>4096)inner.delete(inner.keys().next().value!);
    return `${event.id}:codemode:${n}`;
  };
  try {
    registrations.push(await context.tool.transform(editor=>{
      for(const definition of MEMORY_TOOLS)editor.add({
        name:definition.name,description:definition.description,input:structuredClone(definition.inputSchema),options:{codemode:false},
        execute:async(input,tool)=>({content:await core.callTool(definition.name,input ?? {},tool.sessionID,tool.signal)}),
      });
    }));
    registrations.push(await context.tool.hook('execute.after',async event=>{
      try {
        if(event.status!=='completed' || isInternalTool(event.tool))return;
        const visible=openCodeResultText(event.result);if(!visible)return;
        await core.capture(event.sessionID,await codeModeCall(event),event.tool,event.input,visible.text,event.result?.metadata);
      } catch(error) {core.warn(error);}
    }));
    registrations.push(await context.session.hook('context',async event=>{
      try {
        if(!Array.isArray(event.messages))return;
        const calls=new Map<string,unknown>();
        for(const message of event.messages)if(message?.role==='assistant' && Array.isArray(message.content))
          for(const part of message.content)if(part?.type==='tool-call' && typeof part.id==='string')calls.set(part.id,part.input);
        // Only completed single-text results of locally executed tools. No system text, user text,
        // assistant prose, tool calls, errors, files or provider-executed results are edited.
        const items:{eventId:string;output:string;message:number;part:number}[]=[];
        for(const [m,message] of event.messages.entries()) {
          if(message?.role!=='tool' || !Array.isArray(message.content))continue;
          for(const [p,part] of message.content.entries()) {
            if(part?.type!=='tool-result' || part.providerExecuted===true || typeof part.id!=='string' || typeof part.name!=='string' ||
               isInternalTool(part.name) || part.result?.type!=='text' || typeof part.result.value!=='string')continue;
            try {
              const id=await core.capture(event.sessionID,part.id,part.name,calls.get(part.id) ?? {},part.result.value);
              if(!items.some(item=>item.eventId===id))items.push({eventId:id,output:part.result.value,message:m,part:p});
            } catch(error) {core.warn(error);}
          }
        }
        if(!items.length)return;
        const size=await contextWindow(event.model);
        const usage={source:'estimated' as const,usedTokens:estimateTokens(JSON.stringify([event.system ?? null,event.messages])),...(size?{contextWindow:size}:{})};
        const projected=await core.project(event.sessionID,items,usage);
        const changed=new Map<number,Map<number,string>>();
        for(const item of items) {
          const text=projected.get(item.eventId);
          if(text===undefined)continue;
          const parts=changed.get(item.message) ?? new Map<number,string>();parts.set(item.part,text);changed.set(item.message,parts);
        }
        for(const [m,parts] of changed) {
          const message=event.messages[m] as any;
          const content=(message.content as Part[]).map((part,p)=>{
            const text=parts.get(p);
            const original=items.find(item=>item.message===m && item.part===p)!.output;
            return text===undefined || part.result?.value!==original ? part : {...part,result:{type:'text',value:text}};
          });
          // Messages are schema classes; a rebuilt instance keeps their prototype. Only this
          // outgoing request changes; OpenCode rebuilds requests from persisted history.
          try {
            const Ctor=message?.constructor;
            event.messages[m]=typeof Ctor==='function' && Ctor!==Object ? new Ctor({...message,content}) : {...message,content};
          } catch(error) {core.warn(error);}
        }
      } catch(error) {core.warn(error);}
    }));
  } catch(error) {
    core.warn(error);
  }
  return async()=>{
    for(const registration of registrations.splice(0).reverse()) {
      try {await registration.dispose();} catch(error) {core.warn(error);}
    }
    await core.dispose();
  };
}
