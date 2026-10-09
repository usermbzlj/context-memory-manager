import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ContextManager } from '../core/context-manager.js';
import { MemoryService } from '../runtime/memory.js';
import { loadConfig, configRevision, ConfigConflictError, ConfigLockLeftError } from '../config.js';
import { buildProviders } from '../providers/index.js';
import { provenanceFor } from '../evidence/provenance.js';
import { indexCoverage } from '../evidence/index.js';
import { searchEvidence } from '../evidence/search.js';
import { integer, text } from '../util/validation.js';
import { safeEnd } from '../util/text.js';
import { publicSettings, readSettings, saveSettings } from './settings.js';
import type { CapsuleRow, ToolEventRow } from '../types.js';

interface Scope {id:string;agent:string;workspaceId:string;path:string;createdAt:number}
type Row = Record<string, any>;
const eventColumns = 'e.id,e.agent,e.workspace_id,e.session_id,e.tool_call_id,e.tool_name,e.status,e.turn,e.created_at,e.archived_at,e.input_sha,e.input_bytes,e.result_sha,e.result_bytes,e.chain_id,e.capsule_id,e.pinned,e.persistent_pin,e.state,e.safe_to_evict,e.protected_until_turn,e.recalled_count,e.last_recalled_at';
/** Known, safe failure kinds. Everything else reaches the browser as a generic failure. */
export class ManagementError extends Error {
  constructor(readonly status:number,readonly code:string,message:string) { super(message); this.name='ManagementError'; }
}
const downloadLimit = 32*1024*1024;
const publicMessages:Record<string,string> = {
  NOT_FOUND:'所选范围或记录不可用。',CONFIG_CONFLICT:'配置已被修改，请重新加载设置后再保存。',CONFIG_BUSY:'配置正在被写入，请稍后重新加载设置。',
  MAINTENANCE_RUNNING:'已有维护任务正在执行。',SIZE_LIMIT:'原文超过 32 MiB 下载上限；请改用分页浏览或 context_recall。',
  INVALID_CURSOR:'分页游标无效或已过期，请重新加载列表。',WORKER_CLOSING:'管理进程正在关闭。',
};
const validationMessage = /^[\w.]+ (?:must be (?:an object|a string|a nonempty string of at most \d+ characters \(no NUL\)|an integer in \[-?\d+, \d+\])|contains an unpaired Unicode surrogate)$|^(?:offset exceeds totalChars=\d+|offset splits a Unicode character; use the previous page nextOffset|find must be 1\.\.1000 characters|pinned must be boolean|reindex must be boolean|Invalid (?:content field|filter|pinned filter|completeness|status|role|list kind|provider role))$/;
const notFoundMessage = /^(?:Event not available in this agent\/workspace scope|event not found|no archived event)/;
const unsafeSettingsMessage = /lock|Cannot read|could not be removed|Settings were saved|[A-Za-z]:[\\/]|\/\w+\//i;
/** Maps an internal error to a status, code and message that may cross the browser boundary. */
export function publicFailure(error:unknown,method?:string):{status:number;code:string;message:string}|undefined {
  const e = error as {name?:string;code?:unknown;message?:unknown} | null;
  if (error instanceof ManagementError) return {status:error.status,code:error.code,message:error.code==='INVALID_REQUEST'?error.message:publicMessages[error.code] ?? error.message};
  if (error instanceof ConfigLockLeftError) return {status:500,code:error.code,message:error.message};
  if (e?.name === 'ConfigConflictError') return {status:409,code:'CONFIG_CONFLICT',message:publicMessages.CONFIG_CONFLICT};
  const message = typeof e?.message === 'string' ? e.message : '';
  if (e?.name === 'RecallError' && /^event (?:\S+ was explicitly deleted by archive GC|not found)/.test(message)) return {status:404,code:'NOT_FOUND',message:publicMessages.NOT_FOUND};
  if ((error as {constructor?:unknown} | null)?.constructor !== Error || typeof e?.code === 'string') {
    if (method && ['saveSettings','testProvider'].includes(method) && e?.code === 'ERR_INVALID_URL') return {status:400,code:'INVALID_SETTINGS',message:'Provider 地址无效。'};
    return;
  }
  if (notFoundMessage.test(message)) return {status:404,code:'NOT_FOUND',message:publicMessages.NOT_FOUND};
  if (validationMessage.test(message)) return {status:400,code:'INVALID_REQUEST',message};
  if (/^Configuration (?:is changing|writer lock .* is held)/.test(message)) return {status:409,code:'CONFIG_BUSY',message:publicMessages.CONFIG_BUSY};
  // Settings validation messages are static strings naming only fields the browser sent.
  if (method === 'saveSettings' && message.length <= 240 && /^[\x20-\x7e]+$/.test(message) && !unsafeSettingsMessage.test(message)) return {status:400,code:'INVALID_SETTINGS',message};
}
const cursorKey = randomBytes(32); // per process: survives a settings-triggered service rebuild, never valid in another process
/** Browser-facing DTOs. No archived inline refs, provider error bodies or config secrets cross this facade. */
export class ManagementService {
  constructor(readonly manager: ContextManager) {}
  private scopes(): Scope[] {
    return this.manager.db.queryAll<{agent:string;id:string;path:string;created_at:number}>('SELECT agent,id,path,created_at FROM workspaces ORDER BY agent,id')
      .map(r => ({id:'scope:'+createHash('sha256').update(JSON.stringify([r.agent,r.id])).digest('hex'),agent:r.agent,workspaceId:r.id,path:r.path,createdAt:r.created_at}));
  }
  private scope(value:unknown): Scope {
    const id = text(value,'scopeId',100); const scope = this.scopes().find(s => s.id === id);
    if (!scope) throw new ManagementError(404,'NOT_FOUND','Scope unavailable'); return scope;
  }
  resolveScope(scopeId:unknown):Scope { return this.scope(scopeId); }
  private memory(scope:Scope) { return new MemoryService(this.manager,{agent:scope.agent,workspaceId:scope.workspaceId}); }
  private event(scope:Scope,id:unknown) { return this.memory(scope).event(text(id,'eventId',200)); }
  private eventDto(row: Row) {
    return {id:row.id,eventId:row.id,agent:row.agent,workspaceId:row.workspace_id,sessionId:row.session_id,sourceSession:row.session_id,
      toolCallId:row.tool_call_id,tool:row.tool_name,status:row.status,turn:row.turn,createdAt:row.created_at,archivedAt:row.archived_at,
      input:{sha256:row.input_sha,bytes:row.input_bytes},result:{sha256:row.result_sha,bytes:row.result_bytes},bytes:row.result_bytes,
      chainId:row.chain_id,capsuleId:row.capsule_id,pinned:Boolean(row.pinned),persistentPin:Boolean(row.persistent_pin),state:row.state,
      safeToEvict:row.safe_to_evict,protectedUntilTurn:row.protected_until_turn,recalledCount:row.recalled_count,lastRecalledAt:row.last_recalled_at,
      provenance:provenanceFor(this.manager.db,row.id),coverage:indexCoverage(this.manager.db,row.id)};
  }
  private cursor(payload:Row):string { const body = Buffer.from(JSON.stringify(payload)).toString('base64url'); return body+'.'+createHmac('sha256',cursorKey).update(body).digest('base64url'); }
  private readCursor(value:unknown,binding:string):Row|undefined {
    if (value == null || value === '') return;
    if (typeof value !== 'string' || value.length > 12000) throw new ManagementError(400,'INVALID_CURSOR','Invalid cursor');
    const [body,signature,...extra] = value.split('.'); const expected = createHmac('sha256',cursorKey).update(body).digest();
    const actual = Buffer.from(signature ?? '', 'base64url');
    if (extra.length || actual.toString('base64url') !== signature || actual.length !== expected.length || !timingSafeEqual(expected,actual)) throw new ManagementError(400,'INVALID_CURSOR','Invalid cursor');
    const decoded = JSON.parse(Buffer.from(body,'base64url').toString('utf8')) as Row;
    if (decoded.binding !== binding || !Number.isSafeInteger(decoded.time) || typeof decoded.id !== 'string' || decoded.expires < Date.now()) throw new ManagementError(400,'INVALID_CURSOR','Expired or mismatched cursor');
    return decoded;
  }
  async execute(method:string,p:Record<string,unknown>):Promise<unknown> {
    if (method === 'scopes') return {scopes:this.scopes()};
    const storage = this.manager.config.storage.path;
    if (method === 'settings') return readSettings(storage);
    if (method === 'saveSettings') {
      try { return await saveSettings(storage,text(p.expectedRevision,'expectedRevision',64),p.patch); }
      catch (error) {
        // The save is durable; report it as saved (the worker adopts it) with a static warning rather than a failure that invites a conflicting retry.
        if (!(error instanceof ConfigLockLeftError)) throw error;
        return {...publicSettings(error.config,storage,configRevision(storage)),saved:true,adopted:false,reloadRequired:true,
          warning:{code:error.code,message:error.message}};
      }
    }
    if (method === 'testProvider') return this.testProvider(p);
    if (method === 'list' && p.kind === 'providers') {
      if (p.scopeId) this.scope(p.scopeId);
      return this.list({id:'storage-global',agent:'',workspaceId:'',path:'',createdAt:0},p);
    }
    const scope = this.scope(p.scopeId);
    switch(method) {
      case 'scope': return scope;
      case 'overview': return this.overview(scope);
      case 'list': return this.list(scope,p);
      case 'detail': return this.detail(scope,p.eventId);
      case 'chain': return this.chain(scope,p.chainId);
      case 'capsule': return this.capsule(scope,p.capsuleId);
      case 'content': {
        this.event(scope,p.eventId);
        const page = await this.memory(scope).recall(text(p.eventId,'eventId',200),{field:this.field(p.field),
          offset:integer(p.offset ?? 0,'offset',0,Number.MAX_SAFE_INTEGER),limit:integer(p.limit ?? 12000,'limit',1,64000),
          ...(p.find !== undefined ? {find:text(p.find,'find',1000)} : {})});
        // Recall may extend a page by one unit to preserve a surrogate pair.
        // The browser boundary has an absolute 64,000-unit response limit.
        if (page.text.length > 64000) {
          const content=page.text.slice(0,safeEnd(page.text,64000));
          return {...page,text:content,end:page.offset!+content.length,nextOffset:page.offset!+content.length,complete:false};
        }
        return page;
      }
      case 'download': {
        const row = this.event(scope,p.eventId); const field = this.field(p.field);
        const bytes = field === 'input' ? row.input_bytes : row.result_bytes;
        // fetchOriginal has no per-field read, so bound what it will materialize: the field itself and both fields together.
        if (bytes > downloadLimit || row.input_bytes + row.result_bytes > 2*downloadLimit) throw new ManagementError(413,'SIZE_LIMIT','Download exceeds 32 MiB limit');
        const raw = await this.manager.archive.fetchOriginal(row.id);
        if (Buffer.byteLength(raw[field]) > downloadLimit) throw new ManagementError(413,'SIZE_LIMIT','Download exceeds 32 MiB limit');
        return {text:raw[field],bytes,sha256:field === 'input' ? row.input_sha : row.result_sha,
          filename:row.id.replace(/[^a-zA-Z0-9_-]/g,'_')+'-'+field+'.txt'};
      }
      case 'pin': {
        if (typeof p.pinned !== 'boolean') throw new Error('pinned must be boolean');
        return this.memory(scope).pin(text(p.eventId,'eventId',200),p.pinned);
      }
      case 'diagnostics': return this.diagnostics(scope);
      case 'verify': {
        if (p.reindex !== undefined && typeof p.reindex !== 'boolean') throw new Error('reindex must be boolean');
        const result = await this.memory(scope).verify(p.reindex === true);
        return {...result,failures:result.failures.map(f => ({eventId:f.eventId,code:'INTEGRITY_CHECK_FAILED'})),integrity:undefined};
      }
      default: throw new Error('Unknown management method');
    }
  }
  private field(value:unknown):'input'|'result' { if (value === undefined) return 'result'; if (value !== 'input' && value !== 'result') throw new Error('Invalid content field'); return value; }
  private diagnostics(s:Scope) {
    const files:Record<string,string[]>={codex:['.codex/config.toml','.codex/hooks.json'],kimi:['.kimi-code/mcp.json'],opencode:['.opencode/plugins/context-memory-manager.ts'],claude:['.claude/settings.local.json','.mcp.json']};
    const artifacts=(files[s.agent]??[]).map(relative=>({relativePath:relative,present:fs.existsSync(path.join(s.path,relative)),contentMatch:'not-checked'}));
    return {scope:s,storage:{schemaVersion:4},environment:{nodeVersion:process.version,platform:process.platform},health:this.health(s),
      capabilities:{nativeCaptureOnly:['codex','kimi'].includes(s.agent),historyProjection:s.agent==='opencode',liveHostValidated:'unknown'},
      installation:{scope:'workspace',artifacts,hostTrust:'unknown',mcpDiscovery:'unknown',note:'File presence alone does not confirm matching installation, host approval or live capture.'},
      indexCoverage:this.coverage(s),providerCallsScope:'storage-global',cost:'unpriced',configRevision:configRevision(this.manager.config.storage.path)};
  }
  private health(s:Scope) {
    return this.manager.db.queryAll<Row>('SELECT mode,last_seen,observations,last_error IS NOT NULL AS has_error FROM integration_health WHERE agent=? AND workspace_id=? ORDER BY mode',[s.agent,s.workspaceId])
      .map(r => ({mode:r.mode,lastSeen:r.last_seen,observations:r.observations,hasError:Boolean(r.has_error),liveValidated:false}));
  }
  private coverage(s:Scope) {
    return this.manager.db.queryOne<Row>(`SELECT COUNT(*) AS events,
      COALESCE(SUM((SELECT COUNT(*) FROM evidence_index i WHERE i.event_id=e.id)=2 AND NOT EXISTS(SELECT 1 FROM evidence_index i WHERE i.event_id=e.id AND i.indexed_chars<i.total_chars)),0) AS full,
      COALESCE(SUM((SELECT COUNT(*) FROM evidence_index i WHERE i.event_id=e.id)<2),0) AS legacy,
      COALESCE(SUM((SELECT COUNT(*) FROM evidence_index i WHERE i.event_id=e.id)=2 AND EXISTS(SELECT 1 FROM evidence_index i WHERE i.event_id=e.id AND i.indexed_chars<i.total_chars)),0) AS partial
      FROM tool_events e WHERE e.agent=? AND e.workspace_id=?`,[s.agent,s.workspaceId]);
  }
  private overview(s:Scope) {
    const params = [s.agent,s.workspaceId];
    const archive = this.manager.db.queryOne<Row>('SELECT COUNT(*) AS events,COALESCE(SUM(input_bytes+result_bytes),0) AS bytes,MAX(created_at) AS lastCapturedAt FROM tool_events WHERE agent=? AND workspace_id=?',params);
    const states = Object.fromEntries(this.manager.db.queryAll<Row>('SELECT state,COUNT(*) AS count FROM tool_events WHERE agent=? AND workspace_id=? GROUP BY state',params).map(r => [r.state,r.count]));
    const batches = this.manager.db.queryOne<Row>(`SELECT COALESCE(SUM(b.batches),0) AS count,MAX(b.updated_at) AS lastUpdatedAt FROM history_batches b JOIN sessions s ON s.id=b.session_id WHERE s.agent=? AND s.workspace_id=?`,params);
    const receipts = this.manager.db.queryOne<Row>('SELECT COUNT(*) AS count FROM projection_cache p JOIN tool_events e ON e.id=p.event_id WHERE e.agent=? AND e.workspace_id=?',params);
    return {scope:s,archive,states:{hot:0,capsule:0,evicted:0,...states},health:this.health(s),indexCoverage:this.coverage(s),historyBatches:batches,projectionReceipts:receipts,
      updatedAt:Date.now(),stateMeaning:'desired retention view',bytesMeaning:'logical captured UTF-8 bytes',receiptsMeaning:'views returned; model consumption and billing unknown',providerCallsScope:'storage-global',cost:'unpriced'};
  }
  private async detail(s:Scope,id:unknown) {
    const row = this.event(s,id);
    return {event:this.eventDto(row),descriptor:JSON.parse(row.descriptor_json),
      scores:this.manager.db.queryAll('SELECT id,scorer,safe_to_evict AS safeToEvict,turn,created_at AS createdAt FROM retention_scores WHERE event_id=? ORDER BY id DESC LIMIT 100',[row.id]),
      decisions:this.manager.db.queryAll('SELECT id,decision,reason,score,turn,created_at AS createdAt FROM decisions WHERE event_id=? ORDER BY id DESC LIMIT 100',[row.id]),
      pins:this.manager.db.queryAll('SELECT target_type AS targetType,persistent,created_at AS createdAt FROM pins WHERE target_type=? AND target_id=?',['event',row.id]),
      relatedEvidence:this.memory(s).related(row.id),
      projections:this.manager.db.queryAll('SELECT mode,representation,created_at AS createdAt,source_sha AS sourceSha256,visible_sha AS visibleSha256 FROM projection_cache WHERE event_id=? ORDER BY created_at DESC LIMIT 100',[row.id])
        .map((p:any)=>({...p,integrity:'not-checked'}))};
  }
  private chain(s:Scope,id:unknown) {
    const chain = this.manager.db.queryOne<Row>('SELECT id,session_id AS sessionId,status,capsule_id AS capsuleId,created_at AS createdAt,updated_at AS updatedAt FROM chains WHERE id=? AND agent=? AND workspace_id=?',[text(id,'chainId',200),s.agent,s.workspaceId]);
    if (!chain) throw new ManagementError(404,'NOT_FOUND','Chain unavailable in scope');
    const members = this.manager.db.queryAll<Row>(`SELECT ${eventColumns} FROM chain_members m JOIN tool_events e ON e.id=m.event_id WHERE m.chain_id=? AND e.agent=? AND e.workspace_id=? AND e.session_id=? ORDER BY m.position LIMIT 100`,[chain.id,s.agent,s.workspaceId,chain.sessionId]);
    return {...chain,events:members.map(e=>this.eventDto(e)),eventsTruncated:members.length===100};
  }
  private capsuleCondition() {
    return `NOT EXISTS(SELECT 1 FROM json_each(c.source_event_ids_json) j LEFT JOIN tool_events foreign_event ON foreign_event.id=j.value WHERE foreign_event.id IS NULL OR foreign_event.agent!=? OR foreign_event.workspace_id!=?)
      AND (EXISTS(SELECT 1 FROM json_each(c.source_event_ids_json) j JOIN tool_events e ON e.id=j.value WHERE e.agent=? AND e.workspace_id=?)
      OR EXISTS(SELECT 1 FROM tool_events e WHERE e.capsule_id=c.id AND e.agent=? AND e.workspace_id=?)
      OR EXISTS(SELECT 1 FROM chains ch WHERE ch.capsule_id=c.id AND ch.agent=? AND ch.workspace_id=?)
      OR EXISTS(SELECT 1 FROM event_views v JOIN tool_events e ON e.id=v.event_id WHERE v.capsule_id=c.id AND e.agent=? AND e.workspace_id=?))`;
  }
  private capsuleParams(s:Scope) { return Array.from({length:5},()=>[s.agent,s.workspaceId]).flat(); }
  private capsule(s:Scope,id:unknown) {
    const row = this.manager.db.queryOne<CapsuleRow>(`SELECT c.id,c.source_event_ids_json,c.summary,c.facts_json,c.anchors_json,c.outcome,c.frozen,c.created_at,c.updated_at FROM capsules c WHERE c.id=? AND ${this.capsuleCondition()}`,[text(id,'capsuleId',200),...this.capsuleParams(s)]);
    if (!row) throw new ManagementError(404,'NOT_FOUND','Capsule unavailable in scope');
    return {id:row.id,sourceEventIds:JSON.parse(row.source_event_ids_json),summary:row.summary,facts:JSON.parse(row.facts_json),anchors:JSON.parse(row.anchors_json),outcome:row.outcome,frozen:Boolean(row.frozen),createdAt:row.created_at,updatedAt:row.updated_at,kind:'derived-summary'};
  }
  private list(s:Scope,p:Record<string,unknown>) {
    const kind = text(p.kind,'kind',20), limit = integer(p.limit ?? 50,'limit',1,p.query ? 50 : 100);
    const filters:Row = {};
    for (const key of ['query','sessionId','tool','status','state','pinned','completeness','role','provider']) if (p[key] !== undefined) filters[key] = p[key];
    if (p.sessionId !== undefined && !this.manager.db.queryOne('SELECT id FROM sessions WHERE id=? AND agent=? AND workspace_id=?',[text(p.sessionId,'sessionId',200),s.agent,s.workspaceId])) throw new ManagementError(404,'NOT_FOUND','Session unavailable in scope');
    const binding = createHash('sha256').update(JSON.stringify({scope:s.id,kind,limit,filters})).digest('hex');
    const cursor = this.readCursor(p.cursor,binding);
    let sql:string, params:(string|number)[] = [s.agent,s.workspaceId], time='created_at',id='id';
    if (kind === 'events') {
      sql = `SELECT ${eventColumns} FROM tool_events e WHERE e.agent=? AND e.workspace_id=?`; time='e.created_at'; id='e.id';
      for (const [key,column,allowed] of [['tool','tool_name',undefined],['status','status',['ok','error']],['state','state',['hot','capsule','evicted']],['sessionId','session_id',undefined]] as const) if (p[key] !== undefined) {
        const value = text(p[key],key,200); if (allowed && !(allowed as readonly string[]).includes(value)) throw new Error('Invalid filter'); sql += ` AND e.${column}=?`; params.push(value);
      }
      if (p.pinned !== undefined) {if (typeof p.pinned !== 'boolean') throw new Error('Invalid pinned filter'); sql+=' AND e.pinned=?';params.push(p.pinned ? 1 : 0);}
      if (p.completeness !== undefined) { const v=text(p.completeness,'completeness',20);if(!['unknown','complete','partial'].includes(v))throw new Error('Invalid completeness');sql+=" AND COALESCE((SELECT json_extract(pr.json,'$.completeness') FROM evidence_provenance pr WHERE pr.event_id=e.id),'unknown')=?";params.push(v);}
      if (p.query) { text(p.query,'query',1000);
        return this.searchList(s,p,sql,params,binding,cursor,limit);
      }
    } else if (kind === 'sessions') {
      sql=`SELECT id,agent,workspace_id AS workspaceId,current_turn AS currentTurn,created_at AS createdAt,last_active AS lastActive,
        (SELECT COUNT(*) FROM tool_events e WHERE e.session_id=sessions.id AND e.agent=sessions.agent AND e.workspace_id=sessions.workspace_id) AS eventCount
        FROM sessions WHERE agent=? AND workspace_id=?`;
    } else if (kind === 'chains') {
      sql=`SELECT id,session_id AS sessionId,status,capsule_id AS capsuleId,created_at AS createdAt,updated_at AS updatedAt,
        (SELECT COUNT(*) FROM chain_members m JOIN tool_events e ON e.id=m.event_id WHERE m.chain_id=chains.id AND e.agent=chains.agent AND e.workspace_id=chains.workspace_id AND e.session_id=chains.session_id) AS eventCount
        FROM chains WHERE agent=? AND workspace_id=?`;
      if(p.sessionId !== undefined){sql+=' AND session_id=?';params.push(String(p.sessionId));}
      if(p.status !== undefined){const status=text(p.status,'status',20);if(!['active','completed'].includes(status))throw new Error('Invalid status');sql+=' AND status=?';params.push(status);}
    } else if (kind === 'capsules') {
      sql=`SELECT c.id,c.summary,c.frozen,c.created_at AS createdAt,c.updated_at AS updatedAt FROM capsules c WHERE ${this.capsuleCondition()}`;params=this.capsuleParams(s);time='c.created_at';id='c.id';
    } else if (kind === 'providers') {
      // provider_calls has no agent/workspace identity; make the global boundary explicit.
      sql='SELECT id,provider,model,purpose,tokens_in AS tokensIn,tokens_out AS tokensOut,ok,created_at AS createdAt FROM provider_calls WHERE 1=1';params=[];
      if(p.status !== undefined){const status=text(p.status,'status',20);if(!['ok','error'].includes(status))throw new Error('Invalid status');sql+=' AND ok=?';params.push(status==='ok'?1:0);}
      if(p.role !== undefined){const role=text(p.role,'role',20);if(!['retention','capsule','chain'].includes(role))throw new Error('Invalid role');sql+=' AND purpose=?';params.push(role);}
      if(p.provider !== undefined){sql+=' AND provider=?';params.push(text(p.provider,'provider',200));}
    } else throw new Error('Invalid list kind');
    if(cursor){sql+=` AND (${time}<? OR (${time}=? AND ${id}<?))`;params.push(cursor.time,cursor.time,kind==='providers' ? Number(cursor.id) : cursor.id);}
    const rows=this.manager.db.queryAll<Row>(`${sql} ORDER BY ${time} DESC,${id} DESC LIMIT ?`,[...params,limit+1]);
    const items=rows.slice(0,limit).map(row=>kind==='events'?this.eventDto(row):kind==='capsules'?{...row,summary:String(row.summary).slice(0,1000),frozen:Boolean(row.frozen)}:row);const last=rows.slice(0,limit).at(-1);
    return {items,nextCursor:rows.length>limit && last ? this.cursor({binding,time:last.createdAt ?? last.created_at,id:String(last.id),expires:Date.now()+3600000}):null,...(kind==='providers'?{scope:'storage-global',cost:'unpriced',tokensMeaning:'recorded token fields; missing usage may be zero'}:{})};
  }
  private searchList(s:Scope,p:Record<string,unknown>,sql:string,params:(string|number)[],binding:string,cursor:Row|undefined,limit:number) {
    // SearchEvidence performs bounded chunk search with the exact browsing predicates and does not touch recall protection.
    const where=sql.slice(sql.indexOf(' WHERE ')+7);
    const result=searchEvidence(this.manager.db,{sql:where,params:params as string[]},String(p.query),limit,undefined,cursor?.searchCursor);
    const last=result.results.at(-1);
    return {items:result.results.map(r=>({id:r.eventId,...r})),nextCursor:result.nextCursor && last ? this.cursor({binding,time:last.createdAt,id:last.eventId,searchCursor:result.nextCursor,expires:Date.now()+3600000}):null,notice:result.notice};
  }
  private async testProvider(p:Record<string,unknown>) {
    const storage=this.manager.config.storage.path;
    if(text(p.expectedRevision,'expectedRevision',64)!==configRevision(storage))throw new ConfigConflictError();
    const role=text(p.role,'role',20);if(!['retention','capsule','chain'].includes(role))throw new Error('Invalid provider role');
    const cfg=loadConfig(storage).providers[role as 'retention'|'capsule'|'chain'].find(c=>c.name===text(p.name,'name',200));
    if(p.expectedRevision!==configRevision(storage))throw new ConfigConflictError();
    if(!cfg)throw new ManagementError(404,'NOT_FOUND','Saved provider unavailable');
    const started=Date.now();
    const end=this.manager.runtime.operation({kind:'provider',role:role as 'retention'|'capsule'|'chain',provider:cfg.name,model:cfg.model});
    try {
      const native=cfg.kind==='systemone';
      const response=await buildProviders([cfg])[0].complete({system:native?undefined:'Return JSON only with safeToEvict set to 0.5. This is a synthetic connectivity test.',
        user:native?JSON.stringify({state:{events:[{id:'event_0',descriptor:{tool:'Read',status:'ok',inputSummary:'Synthetic test',sizeChars:4,tokenEstimate:1,salient:[],paths:[],isSideEffect:false}}]},questions:{event_0:{type:'noul',instructions:'Is this synthetic test evidence safe to remove?'}}}):'Synthetic test. Return {"safeToEvict":0.5}.',jsonMode:!native,maxTokens:128,timeoutMs:10000});
      const parsed=JSON.parse(response.text); const probability=native?parsed?.answers?.event_0?.noul:parsed?.safeToEvict;
      if(typeof probability!=='number'||!Number.isFinite(probability)||probability<0||probability>1||(native && parsed?.answers?.event_0?.type!=='noul'))throw new Error('Invalid response');
      this.manager.db.insertProviderCall({provider:cfg.name,model:cfg.model,purpose:role as 'retention'|'capsule'|'chain',tokensIn:response.tokensIn,tokensOut:response.tokensOut,costUsd:0,ok:true});
      end({status:'ok'});
      return {ok:true,stage:'synthetic-json-validation',role,name:cfg.name,model:cfg.model,checkedAt:Date.now(),durationMs:Date.now()-started,tokensIn:response.tokensIn,tokensOut:response.tokensOut,cost:'unpriced'};
    } catch {
      end({status:'error'});
      this.manager.db.insertProviderCall({provider:cfg.name,model:cfg.model,purpose:role as 'retention'|'capsule'|'chain',tokensIn:0,tokensOut:0,costUsd:0,ok:false,error:'Synthetic provider test failed'});
      return {ok:false,stage:'synthetic-json-validation',role,name:cfg.name,model:cfg.model,checkedAt:Date.now(),durationMs:Date.now()-started,code:'PROVIDER_TEST_FAILED',cost:'unpriced'};
    }
  }
}
