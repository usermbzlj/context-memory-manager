import { MemoryService, type Capture } from '../runtime/memory.js';
import { object, text, stableJson } from '../util/validation.js';
import { isInternalTool } from '../descriptor.js';

export type HookAgent='claude'|'codex'|'kimi';
export function capturedString(value:unknown):string {
  if(typeof value==='string') return value;
  const encoded=stableJson(value);
  if(typeof encoded!=='string') throw new Error('Missing observable tool input/result');
  return encoded;
}
export function errorStatus(value:unknown,failed=false):'ok'|'error' {
  if(failed)return 'error';
  if(value && typeof value==='object') {
    const v=value as Record<string,unknown>;
    if(v.isError===true || v.interrupted===true || v.is_interrupt===true ||
       [v.exit_code,v.exitCode,v.exit].some(n=>typeof n==='number' && n!==0))return 'error';
  }
  if(value && typeof value==='object') {
    const v=value as Record<string,unknown>;
    if(typeof v.output==='string' && errorStatus(v.output)==='error')return 'error';
  }
  if(typeof value==='string' && /(?:exit\s*code\s*:?|exited with code)\s*[1-9]\d*/i.test(value))return 'error';
  return 'ok';
}
/** Kimi Code 2.x `PostToolUse.tool_output` is `output.slice(0, 2000)` over text parts. */
export const KIMI_OUTPUT_LIMIT=2000;
export function parseHook(agent:HookAgent,payload:unknown):{cwd:string;capture:Capture;response:unknown;event:string}|null {
  const p=object(payload,'hook payload');
  const event=text(p.hook_event_name,'hook_event_name',100);
  if(event!=='PostToolUse' && event!=='PostToolUseFailure')return null;
  const toolName=text(p.tool_name,'tool_name',500);
  if(isInternalTool(toolName))return null;
  const failed=event==='PostToolUseFailure';
  let response=failed ? p.error : agent==='kimi' ? p.tool_output : p.tool_response;
  const prefix=agent==='kimi' && !failed && typeof response==='string' && response.length>=KIMI_OUTPUT_LIMIT;
  // The host cut at a UTF-16 index; a dangling high surrogate is not representable UTF-8.
  if(prefix && /[\uD800-\uDBFF]$/.test(response as string))response=(response as string).slice(0,-1);
  const id=p.tool_use_id ?? p.tool_call_id;
  return {cwd:text(p.cwd,'cwd'),event,response,capture:{
    sessionId:text(p.session_id,'session_id'),toolName,
    ...(id === undefined ? {} : {toolCallId:text(id,'tool call id')}),
    input:capturedString(p.tool_input),result:capturedString(response),status:errorStatus(response,failed),
    ...(prefix ? {provenance:{version:1,origin:'tool-observation',captureStage:'host-result',completeness:'partial',
      notes:[`Kimi Code hooks deliver at most the first ${KIMI_OUTPUT_LIMIT} UTF-16 units of text output; the rest was not observable.`]}} : {}),
  }};
}

/** Hook output is EMPTY unless the host explicitly supports a shape-safe replacement. */
export async function executeHook(service:MemoryService,agent:HookAgent,parsed:NonNullable<ReturnType<typeof parseHook>>):Promise<unknown|undefined> {
  const saved=await service.capture(parsed.capture,`${agent}:hook`);
  if(!saved.archived || !saved.eventId || agent!=='claude' || parsed.event!=='PostToolUse' || parsed.capture.status==='error') return;
  // Only Bash's documented result shape is rewritten. Unknown/structured/multimedia shapes stay intact.
  const response=parsed.response;
  if(parsed.capture.toolName!=='Bash' || !response || typeof response!=='object' || Array.isArray(response))return;
  const output=response as Record<string,unknown>;
  if(typeof output.stdout!=='string' || typeof output.stderr!=='string' || output.isImage!==false || output.interrupted!==false)return;
  const projected=await service.project(saved.eventId,output.stdout,'ingress',undefined,'stdout');
  if(!projected.replaced)return;
  return {hookSpecificOutput:{hookEventName:'PostToolUse',updatedToolOutput:{...output,stdout:projected.text}}};
}
