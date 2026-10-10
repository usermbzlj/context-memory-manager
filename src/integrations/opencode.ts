// OpenCode 1.x adapter. This module is intentionally safe to load in Bun. SQLite lives in a Node child.
import { estimateTokens, isInternalTool } from '../descriptor.js';
import { MEMORY_TOOLS } from '../mcp/tools.js';
import { openCodeBridge, openCodeWorkspace, type Bridge } from './opencode-core.js';
export { openCodeWorkspace };

type SchemaNode={optional():SchemaNode;int():SchemaNode;min(n:number):SchemaNode;max(n:number):SchemaNode};
export type OpenCodeToolFactory=((definition:{description:string;args:Record<string,SchemaNode>;execute:(args:Record<string,unknown>,context:{sessionID:string;abort?:AbortSignal})=>Promise<string>})=>unknown) & {
  schema:{string():SchemaNode;number():SchemaNode;boolean():SchemaNode;enum(values:string[]):SchemaNode};
};
interface Part {type?:string;tool?:string;callID?:string;sessionID?:string;state?:{status?:string;input?:unknown;output?:string;error?:string;metadata?:Record<string,unknown>;attachments?:unknown[]}}
interface Message {info:{role?:string;sessionID?:string};parts:Part[]}

export async function createOpenCodePlugin(input:{directory:string;worktree?:string},options:{
  node:string;cli:string;storage:string;tool:OpenCodeToolFactory;
  /** Injected only by contract tests; never supplied by generated user config. */
  bridge?:Bridge;
}) {
  const core=openCodeBridge(openCodeWorkspace(input),options);
  const windows=new Map<string,number>();
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
    tools[definition.name]=options.tool({description:definition.description,args,execute:(args,context)=>core.callTool(definition.name,args,context.sessionID,context.abort)});
  }
  return {
    tool:tools,
    dispose:()=>core.dispose(),
    async 'chat.params'(data:{sessionID:string;model?:{limit?:{context?:number}}}) {
      const size=data.model?.limit?.context;
      if(typeof size==='number' && Number.isSafeInteger(size) && size>0)windows.set(data.sessionID,size);
      if(windows.size>128)windows.delete(windows.keys().next().value!);
    },
    async 'tool.execute.after'(data:{tool:string;sessionID:string;callID:string;args?:unknown},output:{output?:string;metadata?:Record<string,unknown>}) {
      // Some upstream MCP paths deliver raw CallToolResult here, not this output shape.
      // Those are observed later through completed message parts instead of guessed at.
      if(isInternalTool(data.tool) || typeof output.output!=='string')return;
      try {await core.capture(data.sessionID,data.callID,data.tool,data.args,output.output,output.metadata);}catch(error){core.warn(error);}
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
            const id=await core.capture(session,part.callID,part.tool,part.state.input,part.state.output,part.state.metadata);
            const group=groups.get(session) ?? [];group.push({eventId:id,output:part.state.output,part});groups.set(session,group);
          } catch(error){core.warn(error);}
        }
      }
      for(const [session,items] of groups) {
        const matching=output.messages.filter(m=>m.info?.sessionID===session);
        const messages=matching.length ? matching : output.messages;
        const usage={source:'estimated' as const,usedTokens:estimateTokens(JSON.stringify(messages)),...(windows.has(session)?{contextWindow:windows.get(session)}:{})};
        const projected=await core.project(session,items,usage);
        for(const item of items)
          if(projected.has(item.eventId) && item.part.state?.output===item.output)item.part.state.output=projected.get(item.eventId)!;
      }
    },
  };
}
