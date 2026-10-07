import { provenanceFor, evidenceNotice, type EvidenceProvenance } from '../evidence/provenance.js';
import { indexEvidence, indexCoverage, safeEnd } from '../evidence/index.js';
import { searchEvidence } from '../evidence/search.js';
import { sha256 } from '../storage/blob-store.js';
import { estimateTokens } from '../descriptor.js';
import { createHash, randomUUID } from 'node:crypto';
import type { ContextManager } from '../core/context-manager.js';
import { normalizeWorkspaceId, resolveWorkspaceId, searchBody } from '../storage/archive.js';
import { extractCapsuleDraft } from '../capsule/extractor.js';
import { rowToToolEvent, type ToolEventInput, type ToolEventRow } from '../types.js';
import { integer, text, errorMessage, utf8 } from '../util/validation.js';
import { activePreset } from '../config.js';
import { projectionSource, validateProjectionReceipt, type ProjectionReceipt } from './projection-receipt.js';
import { eventProtectionReason } from '../core/protection.js';

export interface MemoryScope {agent: string; workspaceId: string; shared?: boolean}
export interface Capture {sessionId: string; toolCallId?: string; toolName: string; input: string; result: string; status?: 'ok'|'error'; sideEffect?: boolean; provenance?: EvidenceProvenance}
export interface Projection {eventId: string; originalChars: number; visibleChars: number; replaced: boolean; text: string; reason: string; cacheHit?: boolean}

/** Host session IDs are not globally unique; never mix two agents or projects. */
export function sessionKey(scope: MemoryScope, hostSession: string): string {
  text(hostSession, 'sessionId');
  return 'cmm:' + createHash('sha256').update(JSON.stringify([scope.agent, normalizeWorkspaceId(scope.workspaceId), hostSession])).digest('hex');
}

export class MemoryService {
  readonly scope: MemoryScope;
  constructor(readonly manager: ContextManager, scope: MemoryScope) {
    const agent=text(scope.agent,'agent',200);
    this.scope = {...scope, agent,workspaceId:resolveWorkspaceId(manager.db,agent,text(scope.workspaceId,'workspaceId'),scope.shared)};
  }
  /** Resolve existing host namespaces without reassigning their archived identities. */
  hostSessionId(hostSession: string): string {
    const canonical = sessionKey(this.scope,hostSession);
    const legacy = 'cmm:' + createHash('sha256').update(JSON.stringify([this.scope.agent,this.scope.workspaceId,hostSession])).digest('hex');
    const matches = [...new Set([canonical,legacy])].filter(id => {
      const session=this.manager.db.getSession(id);
      if (!session) return false;
      if (session.agent!==this.scope.agent || session.workspace_id!==this.scope.workspaceId)
        throw new Error('Host session belongs to a different archive scope');
      return true;
    });
    if (matches.length>1) throw new Error('Conflicting legacy host sessions; archive identities were not merged');
    return matches[0] ?? canonical;
  }
  private where(alias = ''): {sql: string; params: string[]} {
    const prefix = alias ? alias+'.' : '';
    return this.scope.shared ? {sql:`${prefix}workspace_id=?`,params:[this.scope.workspaceId]} :
      {sql:`${prefix}workspace_id=? AND ${prefix}agent=?`,params:[this.scope.workspaceId,this.scope.agent]};
  }
  event(id: string): ToolEventRow {
    text(id, 'eventId', 200);
    const where = this.where();
    const row = this.manager.db.queryOne<ToolEventRow>(`SELECT * FROM tool_events WHERE id=? AND ${where.sql}`,[id,...where.params]);
    if (!row) throw new Error('Event not available in this agent/workspace scope (or explicitly deleted). Use context_search.');
    return row;
  }
  async capture(input: Capture, mode = 'capture') {
    const hostSession = text(input.sessionId,'sessionId');
    const record: ToolEventInput = {
      ...input, agent:this.scope.agent, workspaceId:this.scope.workspaceId,
      sessionId:this.hostSessionId(hostSession),toolCallId:input.toolCallId ?? `observed:${randomUUID()}`,status:input.status ?? 'ok',
      provenance:input.provenance ?? {version:1,origin:'tool-observation',
        captureStage:mode==='mcp:proxy' ? 'mcp-result' : mode==='opencode' || mode.endsWith(':hook') ? 'host-result' : 'unknown',
        completeness:'unknown',notes:[]},
    };
    const saved = await this.manager.recordToolComplete(record);
    if (saved.archived && saved.eventId && mode === 'opencode') {
      const row=this.manager.db.getToolEvent(saved.eventId)!;
      this.manager.db.updateToolEvent(row.id,{protected_until_turn:Math.max(row.protected_until_turn,row.turn+activePreset(this.manager.config).minProtectionTurns)});
    }
    this.health(mode,saved.error ?? null);
    if (saved.archived && saved.eventId && this.manager.config.integration.rtkDatabasePath) {
      const provenance=provenanceFor(this.manager.db,saved.eventId);
      if (provenance.origin==='upstream-filtered' && provenance.upstream?.reference) {
        try {
          const {importRtkEvidence}=await import('../integrations/rtk.js');
          const linked=await importRtkEvidence(this,{database:this.manager.config.integration.rtkDatabasePath,
            hash:provenance.upstream.reference,workspace:this.scope.workspaceId});
          if (linked.archived && linked.eventId) this.manager.db.run(
            'INSERT OR IGNORE INTO evidence_links(from_event,to_event,relation,created_at) VALUES(?,?,?,?)',
            [saved.eventId,linked.eventId,'unverified-upstream-hint',Date.now()]);
          else throw new Error('RTK evidence copy failed');
        } catch (error) {this.health('rtk:import',errorMessage(error));}
      }
    }
    return saved;
  }
  lookup(sessionId:string,toolCallId:string,toolName:string) {
    const sid=this.hostSessionId(sessionId);
    const row=this.manager.db.getToolEventByCallId(this.scope.agent,this.scope.workspaceId,text(toolCallId,'toolCallId'),sid);
    return row && row.tool_name===text(toolName,'toolName') ? {eventId:row.id} : null;
  }
  health(mode: string, error: string | null = null): void {
    this.manager.db.run(`INSERT INTO integration_health(agent,workspace_id,mode,last_seen,observations,last_error)
      VALUES(?,?,?,?,1,?) ON CONFLICT(agent,workspace_id,mode) DO UPDATE SET
      last_seen=excluded.last_seen,observations=observations+1,last_error=excluded.last_error`,
      [this.scope.agent,this.scope.workspaceId,mode,Date.now(),error?.slice(0,500) ?? null]);
  }
  search(query = '', limit = 10, before?: number, cursor?: string) {
    return {scope: this.scope, ...searchEvidence(this.manager.db, this.where('e'), query, limit, before, cursor)};
  }
  related(id: string) {
    this.event(id);
    return this.manager.db.queryAll<{eventId:string;relation:string}>(
      `SELECT l.to_event AS eventId,l.relation FROM evidence_links l JOIN tool_events e ON e.id=l.to_event WHERE l.from_event=? AND ${this.where('e').sql}`,
      [id,...this.where('e').params]);
  }
  async recall(id: string, options: {field?: 'input'|'result'; offset?: number; limit?: number; restore?: boolean; sessionId?: string; find?: string} = {}) {
    const row = this.event(id);
    if (options.restore && row.agent !== this.scope.agent)
      throw new Error('Cross-agent shared recall is read-only; omit restore or use the source agent scope');
    const field = options.field ?? 'result';
    if (field !== 'input' && field !== 'result') throw new Error('field must be input or result');
    if (options.restore && field !== 'result') throw new Error('restore requires a complete result page; input recall is read-only');
    let offset = integer(options.offset ?? 0,'offset',0,Number.MAX_SAFE_INTEGER);
    const limit = integer(options.limit ?? 12000,'limit',1,64000);
    const raw = await this.manager.archive.fetchOriginal(id);
    const value = raw[field];
    let matchOffset: number | undefined;
    if (options.find !== undefined) {
      if (!options.find || options.find.length > 1000) throw new Error('find must be 1..1000 characters');
      const matched = value.indexOf(options.find, offset);
      if (matched < 0) return {eventId:id,field,found:false,text:'',nextOffset:null,complete:false,restored:false,
        provenance:provenanceFor(this.manager.db,id),notice:'No literal match in the captured field.'};
      matchOffset = matched;
      // A tiny page must still reach the hit, not just return leading context.
      const contextBefore = Math.min(200, Math.max(0,limit-options.find.length),Math.floor(limit/4));
      offset = Math.max(0,matched-contextBefore);
      if (offset > 0 && /[\uDC00-\uDFFF]/.test(value[offset]) && /[\uD800-\uDBFF]/.test(value[offset-1])) offset--;
    }
    if (offset > value.length) throw new Error(`offset exceeds totalChars=${value.length}`);
    if (offset > 0 && /[\uDC00-\uDFFF]/.test(value[offset] ?? '') && /[\uD800-\uDBFF]/.test(value[offset-1]))
      throw new Error('offset splits a Unicode character; use the previous page nextOffset');
    let end = Math.min(value.length,offset+limit);
    if (end < value.length && /[\uD800-\uDBFF]/.test(value[end-1] ?? '') && /[\uDC00-\uDFFF]/.test(value[end])) end++;
    const complete = offset === 0 && end === value.length;
    if (options.restore && !complete) throw new Error('restore requires a complete single-page read; paginate large results without restoring them');
    let restored = false;
    if (options.restore) {
      const target = options.sessionId ? this.hostSessionId(options.sessionId) : undefined;
      await this.manager.recallEvent(id,row.agent,row.workspace_id,target);
      restored = true;
    }
    const provenance=provenanceFor(this.manager.db,id);
    return {eventId:id,field,found:true,provenance,relatedEvidence:this.related(id),notice:evidenceNotice(provenance),status:row.status,tool:row.tool_name,sourceSession:row.session_id,
      sha256:field === 'result' ? row.result_sha : row.input_sha,
      totalBytes:field === 'result' ? row.result_bytes : row.input_bytes,totalChars:value.length,
      offset,end,matchOffset,nextOffset:end<value.length ? end : null,offsetUnit:'UTF-16 code units',complete,restored,
      text:value.slice(offset,end)};
  }
  async pin(id: string, pinned: boolean) {
    const row = this.event(id);
    if (row.agent !== this.scope.agent) throw new Error('Cross-agent shared access is read-only; use the source agent scope to pin');
    if (pinned) {
      // A pin is meaningful even if the event was already compressed.
      await this.manager.archive.fetchOriginal(id);
      this.manager.db.transaction(() => {
        this.manager.db.insertPin('event',id,null,true);
        this.manager.db.updateToolEvent(id,{pinned:1,persistent_pin:1,state:'hot'});
      });
    } else {
      this.manager.db.deletePin('event',id);
      this.manager.db.updateToolEvent(id,{pinned:0,persistent_pin:0});
    }
    return {eventId:id,pinned,scope:'all sessions for this event',sourceSession:row.session_id};
  }
  protected(row: ToolEventRow, sessionId = row.session_id): boolean {
    return Boolean(eventProtectionReason(this.manager.db,row,activePreset(this.manager.config).minProtectionTurns,sessionId));
  }
  /** Hash-bound, session-bound receipts; a handle prefix alone proves nothing. */
  async project(id: string, original: string, mode: 'ingress'|'history', hostSession?: string,
    representation: 'text'|'stdout'|'mcp-text' = 'text', options: {commit?: boolean} = {}): Promise<Projection> {
    if (typeof original !== 'string') throw new Error('Projection output must be text');
    const sourceRow = this.event(id);
    const target = hostSession ? this.hostSessionId(hostSession) : sourceRow.session_id;
    if (target !== sourceRow.session_id && !this.manager.db.getEventView(id,target))
      throw new Error('Event does not belong to this history session; explicitly recall it first');
    const raw = await this.manager.archive.fetchOriginal(id);
    const archivedText = projectionSource(raw.result, representation);
    const sourceSha = sha256(archivedText);
    const cached = this.manager.db.queryOne<ProjectionReceipt>(
      'SELECT * FROM projection_cache WHERE event_id=? AND session_id=? AND mode=? AND representation=?',
      [id,target,mode,representation]);
    if (cached) validateProjectionReceipt(this.manager.db, sourceRow, cached, raw.result);
    const recognized = original === archivedText || Boolean(cached && original === cached.text);
    const base = (reason: string, value = original): Projection => ({eventId:id,originalChars:archivedText.length,
      visibleChars:value.length,replaced:value !== original,text:value,reason});
    if (!recognized) return base('output-changed-since-archive');
    // SQLite TEXT readers can truncate NUL. Preserve this unusual source rather
    // than write a projection receipt which would not round-trip exactly.
    if (archivedText.includes('\0')) return base('non-plain-text',archivedText);
    const cfg = this.manager.config.integration;
    const provenance = provenanceFor(this.manager.db,id);
    // Do not silently shrink an already filtered or known-incomplete upstream result again.
    if (provenance.origin === 'upstream-filtered') return base('upstream-filtered',archivedText);
    if (provenance.completeness === 'partial') return base('incomplete-source',archivedText);
    const row = this.manager.db.getEventView(id,target) ?? sourceRow;
    if (cfg.captureOnly) return base('capture-only',archivedText);
    if (mode === 'ingress' && !cfg.ingressCompression) return base('ingress-opt-in-required',archivedText);
    if (this.protected(row,target)) return base('protected',archivedText);
    if (mode === 'history' && row.state === 'hot') return base('hot',archivedText);
    if (mode === 'ingress' && (row.status === 'error' || (representation !== 'mcp-text' && rowToToolEvent(row).descriptor.isSideEffect)))
      return base('error-or-side-effect',archivedText);
    // Reuse exact bytes even if retention scores, strategy or extraction code changed.
    if (cached) return {...base('stable-projection',cached.text),cacheHit:true};
    if (mode === 'ingress' && archivedText.length <= cfg.maxOutputChars) return base('below-size-limit');
    const draft = extractCapsuleDraft(rowToToolEvent(row));
    const header = `[CMM archive ${id}] ${row.tool_name} | ${row.status}\n` +
      `Evidence extract, NOT the full result. Captured: ${archivedText.length} UTF-16 chars.\n` +
      `${evidenceNotice(provenance)}\n` +
      `Read: context_recall({"eventId":"${id}","offset":0,"limit":12000}).\n`;
    const budget = Math.min(cfg.maxOutputChars,mode === 'history' && row.state === 'evicted' ? 1600 : 8000);
    const clip = (value:string,n:number) => value.slice(0,safeEnd(value,Math.max(0,n)));
    const evidence = clip([draft.summary,...draft.facts,...draft.anchors.map(a => 'path: '+a)].join('\n'),Math.min(2400,Math.max(0,budget-header.length-110)));
    const remaining = Math.max(0,budget-header.length-evidence.length-110);
    const head = Math.floor(remaining*0.6), tail = remaining-head;
    const tailStart = Math.min(archivedText.length,safeEnd(archivedText,archivedText.length-tail));
    const excerpt = head+tail > 0 ? `\n--- verbatim head ---\n${clip(archivedText,head)}\n--- omitted ---\n${tail ? archivedText.slice(tailStart) : ''}\n--- end excerpt ---` : '';
    const compact = header+evidence+excerpt;
    utf8(compact, 'projection output');
    if (compact.length > budget || compact.length+cfg.minSavingsChars >= archivedText.length) return base('no-meaningful-savings');
    const fresh = this.manager.db.getEventView(id,target) ?? this.event(id);
    if (this.protected(fresh,target) || (mode === 'history' && fresh.state === 'hot')) return base('concurrent-protection',archivedText);
    const projection = {...base(mode === 'history' ? row.state : 'large-result',compact),cacheHit:false};
    if (options.commit !== false) this.commitProjection(projection,target,mode,representation,sourceSha);
    return projection;
  }
  private commitProjection(p: Projection, target: string, mode: string, representation: string, sourceSha: string): void {
    utf8(p.text, 'projection output');
    this.manager.db.transaction(() => {
      const row=this.manager.db.getEventView(p.eventId,target) ?? this.event(p.eventId);
      if (this.protected(row,target) || (mode==='history' && row.state==='hot')) throw new Error('Projection protection changed');
      const existing=this.manager.db.queryOne<{source_sha:string;visible_sha:string;text:string}>(
        'SELECT source_sha,visible_sha,text FROM projection_cache WHERE event_id=? AND session_id=? AND mode=? AND representation=?',
        [p.eventId,target,mode,representation]);
      if (existing) {
        if (existing.source_sha!==sourceSha || existing.visible_sha!==sha256(existing.text)) throw new Error('Projection cache conflict');
        p.text=existing.text; p.visibleChars=existing.text.length; p.cacheHit=true;
      }
      this.manager.db.run(`INSERT INTO projection_cache(event_id,session_id,mode,representation,source_sha,visible_sha,text,created_at)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(event_id,session_id,mode,representation) DO NOTHING`,
        [p.eventId,target,mode,representation,sourceSha,sha256(p.text),p.text,Date.now()]);
      this.manager.db.run(`INSERT INTO projections(event_id,mode,session_id,original_chars,visible_chars,created_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(event_id,mode,session_id) DO UPDATE SET
        original_chars=excluded.original_chars,visible_chars=excluded.visible_chars,created_at=excluded.created_at`,
        [p.eventId,mode,target,p.originalChars,p.visibleChars,Date.now()]);
    });
  }
  async transform(hostSession: string, items: {eventId:string;output:string}[],
    hostUsage?: {usedTokens:number;contextWindow?:number;source?:'estimated'|'host-reported'}) {
    if (!Array.isArray(items) || items.length > 1000) throw new Error('At most 1000 tool outputs per transform');
    const sid = this.hostSessionId(hostSession);
    const cfg = this.manager.config.integration;
    const preset = activePreset(this.manager.config);
    const window = integer(hostUsage?.contextWindow ?? cfg.contextWindow,'contextWindow',1024,100000000);
    const used = integer(hostUsage?.usedTokens ?? items.reduce((n,i) => n+estimateTokens(i.output),0),'usedTokens',0,1000000000);
    const turn = this.manager.db.getCurrentTurn(sid);
    const source = hostUsage?.source ?? (hostUsage ? 'host-reported' : 'estimated-tools-only');
    const seen = new Set<string>();
    const valid: {item:typeof items[number]; row:ToolEventRow}[] = [];
    const projections: Projection[] = [];
    for (const item of items) {
      if (!item || typeof item.eventId !== 'string' || typeof item.output !== 'string') throw new Error('Invalid history item');
      if (seen.has(item.eventId)) throw new Error('Duplicate event in history transform');
      seen.add(item.eventId);
      try {
        const row = this.event(item.eventId);
        if (row.session_id !== sid && !this.manager.db.getEventView(row.id,sid)) throw new Error('Foreign-session history event');
        const cache = this.manager.db.queryOne('SELECT 1 FROM projection_cache WHERE event_id=? AND session_id=? AND mode=?',[row.id,sid,'history']);
        if (cache) {
          // Reuse or restore an existing view without charging another compression batch.
          projections.push(await this.project(row.id,item.output,'history',hostSession));
        } else valid.push({item,row:this.manager.db.getEventView(row.id,sid) ?? row});
      } catch (error) {this.health('history',errorMessage(error));}
    }
    const finish = (reason:string,tidy:unknown=null) => ({tidy,projections,policy:{reason,usageSource:source,
      reportedTokens:used,contextWindow:window,tokenValuesAreEstimates:source !== 'host-reported',
      notice:'Returned candidate views, not provider acknowledgement, cache hits or measured billing.'}});
    if (cfg.captureOnly) {
      // Preserve the legacy no-op shape when there is nothing to restore.
      return projections.some(p => p.replaced) ? finish('capture-only-restoration') : {tidy:null,projections:[]};
    }
    let effectiveUsed = used;
    for (const p of projections) {
      const input = items.find(i => i.eventId === p.eventId)!;
      effectiveUsed += estimateTokens(p.text)-estimateTokens(input.output);
    }
    if (effectiveUsed/window < preset.trigger) return finish('below-pressure-trigger');
    const previous = this.manager.db.queryOne<{last_turn:number}>('SELECT last_turn FROM history_batches WHERE session_id=?',[sid]);
    if (previous && turn-previous.last_turn < cfg.historyCooldownTurns && effectiveUsed/window < 0.95)
      return finish('history-cooldown');
    // Only archive rows present in this host request may become candidates. Old rows
    // absent from the host transcript cannot count as saved context.
    const eligible = valid.filter(({row}) => {
      const provenance = provenanceFor(this.manager.db,row.id);
      return !this.protected(row,sid) && provenance.origin !== 'upstream-filtered' && provenance.completeness !== 'partial';
    }).sort((a,b) => b.row.turn-a.row.turn).slice(0,24);
    const verified: typeof eligible = [];
    for (const entry of eligible) {
      try {
        const raw = await this.manager.archive.fetchOriginal(entry.row.id);
        if (raw.result === entry.item.output) verified.push(entry);
      } catch (error) {this.health('history',errorMessage(error));}
    }
    if (!verified.length) return finish('no-eligible-visible-evidence');
    const decisions = await this.manager.retention.decideAll(verified.filter(e => e.row.state === 'hot').map(e => rowToToolEvent(e.row)),
      {pressure:Math.min(1,effectiveUsed/window)});
    const proposed: Projection[] = [];
    let savedTokens=0, savedChars=0;
    for (const entry of verified) {
      try {
        const p = await this.project(entry.row.id,entry.item.output,'history',hostSession,'text',{commit:false});
        if (p.replaced && p.text.length < entry.item.output.length) {
          proposed.push(p); savedChars+=entry.item.output.length-p.text.length;
          savedTokens+=estimateTokens(entry.item.output)-estimateTokens(p.text);
          if (effectiveUsed-savedTokens <= window*preset.release) break;
        }
      } catch (error) {this.health('history',errorMessage(error));}
    }
    const tidy={evaluated:decisions.length,kept:decisions.filter(d=>d.decision==='keep').length,
      capsuled:decisions.filter(d=>d.decision==='capsule').length,evicted:decisions.filter(d=>d.decision==='evict').length,
      decisions,proposedSavedChars:savedChars};
    if (savedChars < cfg.minHistorySavingsChars) return finish('insufficient-batch-savings',tidy);
    // Atomic publication of an entire batch. A concurrent pin/corrupt archive aborts
    // this batch rather than persisting a misleading successful rewrite receipt.
    try {
      this.manager.db.transaction(() => {
        for (const p of proposed) {
          const row=this.manager.db.getEventView(p.eventId,sid) ?? this.event(p.eventId);
          if (this.protected(row,sid) || row.state==='hot') throw new Error('History batch protection changed');
          this.commitProjection(p,sid,'history','text',row.result_sha);
        }
        const before=items.reduce((n,i)=>n+i.output.length,0);
        const outputById=new Map([...projections,...proposed].map(p=>[p.eventId,p.text]));
        const after=items.reduce((n,i)=>n+(outputById.get(i.eventId) ?? i.output).length,0);
        this.manager.db.run(`INSERT INTO history_batches(session_id,last_turn,batches,source,before_chars,after_chars,changed_events,updated_at)
          VALUES(?,?,1,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET last_turn=excluded.last_turn,batches=batches+1,
          source=excluded.source,before_chars=excluded.before_chars,after_chars=excluded.after_chars,
          changed_events=excluded.changed_events,updated_at=excluded.updated_at`,
          [sid,turn,source,before,after,proposed.length,Date.now()]);
      });
      projections.push(...proposed);
      return finish('pressure-batch-published',tidy);
    } catch (error) {this.health('history',errorMessage(error));return finish('batch-aborted-originals-kept',tidy);}
  }
  status() {
    const where = this.where();
    const summary = this.manager.db.queryOne<{events:number;bytes:number}>(`SELECT count(*) AS events, coalesce(sum(input_bytes+result_bytes),0) AS bytes FROM tool_events WHERE ${where.sql}`,where.params);
    const states = this.manager.db.queryAll<{state:string;count:number}>(`SELECT state,count(*) AS count FROM tool_events WHERE ${where.sql} GROUP BY state`,where.params);
    const health = this.manager.db.queryAll(`SELECT agent,mode,last_seen,observations,last_error FROM integration_health WHERE ${where.sql} ORDER BY last_seen DESC`,where.params);
    const p = this.where('e');
    const reductions = this.manager.db.queryOne<{originalChars:number;visibleChars:number}>(`SELECT coalesce(sum(p.original_chars),0) AS originalChars,coalesce(sum(p.visible_chars),0) AS visibleChars FROM projections p JOIN tool_events e ON e.id=p.event_id WHERE ${p.sql}`,p.params);
    const batches=this.manager.db.queryAll(`SELECT h.* FROM history_batches h JOIN sessions s ON s.id=h.session_id WHERE ${this.where('s').sql} ORDER BY h.updated_at DESC LIMIT 20`,this.where('s').params);
    return {scope:this.scope,archive:summary,states,health,projectionReceipts:reductions,historyBatches:batches,
      stateNote:'Retention states are desired views. Only projection receipts/batches describe returned views; neither proves model consumption.',
      indexCoverage:this.manager.db.queryAll(`SELECT CASE WHEN i.total_chars=i.indexed_chars THEN 'full' ELSE 'partial' END AS coverage,count(*) AS fields FROM evidence_index i JOIN tool_events e ON e.id=i.event_id WHERE ${this.where('e').sql} GROUP BY coverage`,this.where('e').params),
      savingsNote:'Latest projection per event/mode/session, not live context occupancy or measured API token/cost savings.',
      config:{strategy:this.manager.config.strategy,integration:this.manager.config.integration},
      runtime:{node:process.version,sqlite:'built-in',networkRequired:false},
      warning:health.length ? undefined : 'No capture observed. Installing a memory MCP server alone does not observe native tools.'};
  }
  explain(id: string) {
    const row = this.event(id);
    const capsule = row.capsule_id ? this.manager.db.getCapsule(row.capsule_id) : null;
    return {eventId:id,source:{agent:row.agent,workspace:row.workspace_id,session:row.session_id,toolCallId:row.tool_call_id},
      status:row.status,state:row.state,protected:this.protected(row),descriptor:JSON.parse(row.descriptor_json),
      relatedEvidence:this.related(id),provenance:provenanceFor(this.manager.db,id),index:indexCoverage(this.manager.db,id),
      inputSha256:row.input_sha,resultSha256:row.result_sha,chainId:row.chain_id,capsule,
      decisions:this.manager.db.queryAll('SELECT * FROM decisions WHERE event_id=? ORDER BY id DESC LIMIT 20',[id]),
      pins:this.manager.db.listPinsForTarget('event',id)};
  }
  async verify(reindex = false) {
    const where = this.where();
    let checked=0,failed=0;const failures:{eventId:string;error:string}[]=[];
    const rows=this.manager.db.queryAll<ToolEventRow>(`SELECT * FROM tool_events WHERE ${where.sql} ORDER BY id`,where.params);
    for (const row of rows) {
      try {
        const raw=await this.manager.archive.fetchOriginal(row.id);
        if (reindex) this.manager.db.transaction(() => {
          indexEvidence(this.manager.db,row.id,raw.input,raw.result);
          this.manager.db.run('DELETE FROM archive_search WHERE event_id=?',[row.id]);
          this.manager.db.run('INSERT INTO archive_search(event_id,agent,workspace,tool,body) VALUES(?,?,?,?,?)',
            [row.id,row.agent,row.workspace_id,row.tool_name,searchBody(raw.input,raw.result,JSON.parse(row.descriptor_json))]);
        });
        checked++;
      } catch (error) {failed++;if(failures.length<50) failures.push({eventId:row.id,error:errorMessage(error)});}
    }
    let projectionChecked=0, projectionFailed=0;
    const pwhere=this.where('e');
    const receipts=this.manager.db.queryAll<ProjectionReceipt>(
      `SELECT p.* FROM projection_cache p JOIN tool_events e ON e.id=p.event_id WHERE ${pwhere.sql}`,pwhere.params);
    for (const receipt of receipts) {
      projectionChecked++;
      try {
        const row=this.event(receipt.event_id);
        const raw=await this.manager.archive.fetchOriginal(row.id);
        validateProjectionReceipt(this.manager.db,row,receipt,raw.result);
      } catch (error) {
        projectionFailed++; if(failures.length<50) failures.push({eventId:receipt.event_id,error:errorMessage(error)});
      }
    }
    failed+=projectionFailed;
    const integrity = this.manager.db.queryAll<Record<string,unknown>>('PRAGMA quick_check');
    const databaseIntegrityOk=integrity.length===1 && Object.values(integrity[0]).every(v=>v==='ok');
    if(!databaseIntegrityOk) failed++;
    return {checked,failed,projectionChecked,projectionFailed,databaseIntegrityOk,failures,failuresTruncated:failed>failures.length,reindexed:reindex,integrity};
  }
}
