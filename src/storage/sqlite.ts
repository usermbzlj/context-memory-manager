/**
 * SQLite storage layer for the Phase 1 Core prototype.
 *
 * `Database` is a thin wrapper around `node:sqlite`'s `DatabaseSync` that
 * applies `SCHEMA_SQL` on open and exposes typed helpers for every table.
 * Rows are passed around as the flat snake_case shapes defined in
 * `src/types.ts`; mapping to domain objects happens in the callers.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { SCHEMA_SQL, SCHEMA_VERSION, runMigrations } from './schema.js';
import type {
  CapsuleRow,
  ChainRow,
  ProviderCallRecord,
  ToolEventRow,
} from '../types.js';

export interface SessionSummary {
  id: string;
  agent: string;
  workspace_id: string;
  current_turn: number;
  created_at: number;
  last_active: number;
}

export interface RetentionScoreRow {
  id: number;
  event_id: string;
  scorer: string;
  safe_to_evict: number;
  turn: number;
  created_at: number;
}

export interface DecisionRow {
  id: number;
  event_id: string;
  decision: string;
  reason: string;
  score: number | null;
  turn: number;
  created_at: number;
}

export interface RecallLogRow {
  id: number;
  event_id: string;
  tool_call_id: string;
  agent: string;
  workspace_id: string;
  recalled_at: number;
  turn: number;
  decision_turn: number | null;
  turns_until_recall: number | null;
  safe_to_evict: number | null;
  decision: string | null;
}

export interface PinRow {
  id: number;
  target_type: string;
  target_id: string;
  session_id: string | null;
  persistent: number;
  created_at: number;
}

export interface ProviderCallRow {
  id: number;
  provider: string;
  model: string;
  purpose: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  ok: number;
  error: string | null;
  created_at: number;
}

const pause = new Int32Array(new SharedArrayBuffer(4));
/** SQLite can return BUSY for a journal-mode switch without consulting busy_timeout, e.g. when
 * several processes create the same database at once; retry synchronously within a bound. */
function retryBusy<T>(fn: () => T, budgetMs: number): T {
  const until = Date.now() + budgetMs;
  for (let wait = 5; ; wait = Math.min(wait * 2, 100)) {
    try { return fn(); } catch (error) {
      const code = (error as { errcode?: unknown }).errcode;
      if (typeof code !== 'number' || (code & 0xff) !== 5 || Date.now() >= until) throw error;
      Atomics.wait(pause, 0, 0, wait);
    }
  }
}

export class Database {
  private readonly db: DatabaseSync;
  private transactionDepth = 0;
  private closed = false;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Open (creating parent dirs as needed), apply the schema, run migrations. */
  static open(dbPath: string): Database {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const existed=fs.existsSync(dbPath);
    const db = new DatabaseSync(dbPath);
    if(!existed && process.platform!=='win32')fs.chmodSync(dbPath,0o600);
    try {
      db.exec('PRAGMA busy_timeout = 5000;');
      const version = (db.prepare('PRAGMA user_version').get() as {user_version: number}).user_version;
      if (version > SCHEMA_VERSION) throw new Error(`Database schema ${version} is newer than supported ${SCHEMA_VERSION}`);
      retryBusy(() => db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;'), 5000);
      db.exec(SCHEMA_SQL);
      runMigrations(db);
      return new Database(db);
    } catch (error) { db.close(); throw error; }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  // ------------------------------------------------------------------
  // Generic query helpers
  // ------------------------------------------------------------------

  queryAll<T>(sql: string, params: unknown[] = []): T[] {
    return this.db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
  }

  queryOne<T>(sql: string, params: unknown[] = []): T | undefined {
    return this.db.prepare(sql).get(...(params as SQLInputValue[])) as T | undefined;
  }

  run(sql: string, params: unknown[] = []): { changes: number; lastInsertRowid: number | bigint } {
    const result = this.db.prepare(sql).run(...(params as SQLInputValue[]));
    return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
  }

  /**
   * Run fn inside a transaction. Uses BEGIN IMMEDIATE so a concurrent
   * writer fails fast (or waits via busy_timeout) instead of deadlocking
   * on lock upgrade. fn must be synchronous: node:sqlite is synchronous,
   * so never await between BEGIN and COMMIT.
   */
  transaction<T>(fn: () => T): T {
    const level = this.transactionDepth++;
    const name = `cmm_savepoint_${level}`;
    try {
      this.db.exec(level === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
      try {
        const result = fn();
        if (result && typeof (result as {then?: unknown}).then === 'function') throw new Error('Database.transaction callbacks must be synchronous');
        this.db.exec(level === 0 ? 'COMMIT' : `RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (error) {
        this.db.exec(level === 0 ? 'ROLLBACK' : `ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`);
        throw error;
      }
    } finally { this.transactionDepth--; }
  }

  /** Dynamic UPDATE builder from a Partial row patch (snake_case keys). */
  private applyPatch(table: string, id: string, patch: Record<string, unknown>): void {
    const entries = Object.entries(patch).filter(([k, v]) => k !== 'id' && v !== undefined);
    if (entries.length === 0) return;
    if (entries.some(([k]) => !/^[a-z_]+$/.test(k))) throw new Error('invalid patch column');
    const setClause = entries.map(([k]) => `${k} = ?`).join(', ');
    const values = entries.map(([, v]) => v);
    this.run(`UPDATE ${table} SET ${setClause} WHERE id = ?`, [...values, id]);
  }

  // ------------------------------------------------------------------
  // Agents / workspaces / sessions
  // ------------------------------------------------------------------

  ensureAgent(name: string): void {
    this.run('INSERT OR IGNORE INTO agents (name, created_at) VALUES (?, ?)', [
      name,
      Date.now(),
    ]);
  }

  ensureWorkspace(agent: string, workspaceId: string, workspacePath: string): void {
    this.run(
      'INSERT OR IGNORE INTO workspaces (id, agent, path, created_at) VALUES (?, ?, ?, ?)',
      [workspaceId, agent, workspacePath, Date.now()],
    );
  }

  ensureSession(agent: string, workspaceId: string, sessionId: string): void {
    const existing = this.getSession(sessionId);
    if (existing && (existing.agent !== agent || existing.workspace_id !== workspaceId)) {
      throw new Error('session identity belongs to a different agent/workspace; use a scoped session ID');
    }
    const now = Date.now();
    this.run(
      'INSERT OR IGNORE INTO sessions (id, agent, workspace_id, current_turn, created_at, last_active) VALUES (?, ?, ?, 0, ?, ?)',
      [sessionId, agent, workspaceId, now, now],
    );
    this.run('UPDATE sessions SET last_active = ? WHERE id = ?', [now, sessionId]);
  }

  bumpTurn(sessionId: string): number {
    return this.transaction(() => {
      this.run('UPDATE sessions SET current_turn = current_turn + 1 WHERE id = ?', [
        sessionId,
      ]);
      return this.getCurrentTurn(sessionId);
    });
  }

  getCurrentTurn(sessionId: string): number {
    const row = this.queryOne<{ current_turn: number }>(
      'SELECT current_turn FROM sessions WHERE id = ?',
      [sessionId],
    );
    return row?.current_turn ?? 0;
  }

  getSession(
    sessionId: string,
  ): { id: string; agent: string; workspace_id: string; current_turn: number } | undefined {
    return this.queryOne<{
      id: string;
      agent: string;
      workspace_id: string;
      current_turn: number;
    }>('SELECT id, agent, workspace_id, current_turn FROM sessions WHERE id = ?', [sessionId]);
  }

  listSessions(): SessionSummary[] {
    return this.queryAll<SessionSummary>(
      'SELECT id, agent, workspace_id, current_turn, created_at, last_active FROM sessions ORDER BY last_active DESC',
    );
  }

  // ------------------------------------------------------------------
  // Tool events
  // ------------------------------------------------------------------

  insertToolEvent(row: ToolEventRow): void {
    this.run(
      `INSERT INTO tool_events (
         id, agent, workspace_id, session_id, tool_call_id, tool_name, status,
         turn, created_at, archived_at,
         input_kind, input_ref, input_sha, input_bytes,
         result_kind, result_ref, result_sha, result_bytes,
         descriptor_json, chain_id, pinned, persistent_pin, state,
         safe_to_evict, protected_until_turn, recalled_count, last_recalled_at, capsule_id
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?,
         ?, ?, ?,
         ?, ?, ?, ?,
         ?, ?, ?, ?,
         ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?
       )`,
      [
        row.id,
        row.agent,
        row.workspace_id,
        row.session_id,
        row.tool_call_id,
        row.tool_name,
        row.status,
        row.turn,
        row.created_at,
        row.archived_at,
        row.input_kind,
        row.input_ref,
        row.input_sha,
        row.input_bytes,
        row.result_kind,
        row.result_ref,
        row.result_sha,
        row.result_bytes,
        row.descriptor_json,
        row.chain_id,
        row.pinned,
        row.persistent_pin,
        row.state,
        row.safe_to_evict,
        row.protected_until_turn,
        row.recalled_count,
        row.last_recalled_at,
        row.capsule_id,
      ],
    );
  }

  getToolEvent(id: string): ToolEventRow | undefined {
    return this.queryOne<ToolEventRow>('SELECT * FROM tool_events WHERE id = ?', [id]);
  }

  getToolEventByCallId(agent: string, workspaceId: string, toolCallId: string, sourceSessionId?: string): ToolEventRow | undefined {
    const rows = this.queryAll<ToolEventRow>(
      `SELECT * FROM tool_events WHERE agent = ? AND workspace_id = ? AND tool_call_id = ?
       ${sourceSessionId ? 'AND session_id = ?' : ''} ORDER BY created_at DESC LIMIT 2`,
      [agent, workspaceId, toolCallId, ...(sourceSessionId ? [sourceSessionId] : [])]);
    if (rows.length > 1) throw new Error('ambiguous tool_call_id across sessions; use eventId or sourceSessionId');
    return rows[0];
  }

  /** Original provenance is immutable; a recalled event has a separate session view. */
  getEventView(eventId: string, sessionId: string): ToolEventRow | undefined {
    const row = this.getToolEvent(eventId);
    if (!row) return undefined;
    if (row.session_id === sessionId) return row;
    const view = this.queryOne<Partial<ToolEventRow> & {event_id: string}>(
      'SELECT * FROM event_views WHERE event_id = ? AND session_id = ?', [eventId, sessionId]);
    // The source chain remains provenance on the original row. A recalled
    // view cannot use it to join, complete or protect a target-session chain.
    return view ? { ...row, ...view, id: row.id, chain_id: null } : undefined;
  }

  updateEventView(eventId: string, sessionId: string, patch: Partial<ToolEventRow>): void {
    const row = this.getToolEvent(eventId);
    if (!row) throw new Error('event does not exist');
    if (row.session_id === sessionId) { this.updateToolEvent(eventId, patch); return; }
    const allowed = new Set(['state', 'turn', 'protected_until_turn', 'capsule_id', 'safe_to_evict', 'recalled_count', 'last_recalled_at']);
    const entries = Object.entries(patch).filter(([k, v]) => allowed.has(k) && v !== undefined);
    if (!entries.length) return;
    this.run(`UPDATE event_views SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE event_id = ? AND session_id = ?`,
      [...entries.map(([, v]) => v), eventId, sessionId]);
  }

  promoteView(eventId: string, sessionId: string, protection: number): void {
    const row = this.getToolEvent(eventId);
    if (!row) throw new Error('event does not exist');
    const session = this.getSession(sessionId);
    if (!session || session.agent !== row.agent || session.workspace_id !== row.workspace_id)
      throw new Error('event view belongs to a different agent/workspace');
    const turn = this.getCurrentTurn(sessionId);
    if (row.session_id === sessionId) {
      this.updateToolEvent(eventId, { state: 'hot', protected_until_turn: turn + protection,
        recalled_count: row.recalled_count + 1, last_recalled_at: Date.now() });
    } else {
      this.run(`INSERT INTO event_views(event_id,session_id,turn,state,protected_until_turn,recalled_count,last_recalled_at)
        VALUES(?,?,?,'hot',?,1,?) ON CONFLICT(event_id,session_id) DO UPDATE SET
        state='hot',turn=excluded.turn,protected_until_turn=excluded.protected_until_turn,
        recalled_count=event_views.recalled_count+1,last_recalled_at=excluded.last_recalled_at`,
        [eventId,sessionId,turn,turn+protection,Date.now()]);
    }
  }

  listHotEvents(sessionId: string): ToolEventRow[] {
    return this.listEvents(sessionId, -1).filter(r => r.state === 'hot').sort((a,b) => a.turn-b.turn);
  }

  listEvents(sessionId: string, limit = 200): ToolEventRow[] {
    // One bounded join instead of fetching all events and N+1 view lookups.
    const fields=['session_id','turn','state','protected_until_turn','capsule_id','safe_to_evict','recalled_count','last_recalled_at'];
    const projected=fields.map(f=>`CASE WHEN v.event_id IS NOT NULL THEN v.${f} ELSE e.${f} END AS ${f}`).join(',');
    const chain='CASE WHEN v.session_id != e.session_id THEN NULL ELSE e.chain_id END AS chain_id';
    return this.queryAll<ToolEventRow>(`SELECT e.*,${projected},${chain} FROM tool_events e
      LEFT JOIN event_views v ON v.event_id=e.id AND v.session_id=?
      WHERE e.session_id=? OR v.session_id=?
      ORDER BY COALESCE(v.turn,e.turn) DESC,e.created_at DESC,e.id LIMIT ?`,[sessionId,sessionId,sessionId,limit]);
  }

  updateToolEvent(id: string, patch: Partial<ToolEventRow>): void {
    this.applyPatch('tool_events', id, patch as Record<string, unknown>);
  }

  countEventsByState(sessionId?: string): Record<string, number> {
    const rows = sessionId
      ? this.queryAll<{ state: string; n: number }>(
          'SELECT state, COUNT(*) AS n FROM tool_events WHERE session_id = ? GROUP BY state',
          [sessionId],
        )
      : this.queryAll<{ state: string; n: number }>(
          'SELECT state, COUNT(*) AS n FROM tool_events GROUP BY state',
        );
    const out: Record<string, number> = {};
    for (const r of rows) out[r.state] = r.n;
    return out;
  }

  sumEventBytes(): number {
    const row = this.queryOne<{ total: number | null }>(
      'SELECT COALESCE(SUM(input_bytes + result_bytes), 0) AS total FROM tool_events',
    );
    return row?.total ?? 0;
  }

  /**
   * Cold GC candidates: EVICTED events only (never HOT, never capsule —
   * capsule blobs back the archive and must stay), oldest first.
   * When cutoffMs is given, only events archived before it.
   */
  listColdEvicted(cutoffMs: number | null, limit = 100): ToolEventRow[] {
    if (cutoffMs === null) {
      return this.queryAll<ToolEventRow>(
        "SELECT * FROM tool_events WHERE state = 'evicted' ORDER BY archived_at ASC LIMIT ?",
        [limit],
      );
    }
    return this.queryAll<ToolEventRow>(
      "SELECT * FROM tool_events WHERE state = 'evicted' AND archived_at < ? ORDER BY archived_at ASC LIMIT ?",
      [cutoffMs, limit],
    );
  }

  /** How many other events reference this content hash (blob dedup safety). */
  countShaReferences(sha256: string, excludeEventId: string): number {
    const row = this.queryOne<{ n: number }>(
      'SELECT COUNT(*) AS n FROM tool_events WHERE id != ? AND (input_sha = ? OR result_sha = ?)',
      [excludeEventId, sha256, sha256],
    );
    return row?.n ?? 0;
  }

  /**
   * Delete an event and its per-event management rows (chain memberships,
   * scores, decisions, pins). Recall telemetry is kept as history.
   * Blob files must be pruned separately via countShaReferences.
   */
  deleteEventCascade(eventId: string): void {
    this.transaction(() => {
      this.run(`INSERT OR IGNORE INTO archive_tombstones SELECT id, agent, workspace_id, tool_call_id, ? FROM tool_events WHERE id = ?`, [Date.now(), eventId]);
      this.run('DELETE FROM archive_search WHERE event_id = ?', [eventId]);
      this.run('DELETE FROM event_views WHERE event_id = ?', [eventId]);
      this.run('DELETE FROM projections WHERE event_id = ?', [eventId]);
      this.run('DELETE FROM chain_members WHERE event_id = ?', [eventId]);
      this.run('DELETE FROM retention_scores WHERE event_id = ?', [eventId]);
      this.run('DELETE FROM decisions WHERE event_id = ?', [eventId]);
      this.run("DELETE FROM pins WHERE target_type = 'event' AND target_id = ?", [eventId]);
      this.run('DELETE FROM tool_events WHERE id = ?', [eventId]);
    });
  }

  /** Most recent retention decision string for an event, if any. */
  lastDecision(eventId: string): string | null {
    const row = this.queryOne<{ decision: string }>(
      'SELECT decision FROM decisions WHERE event_id = ? ORDER BY id DESC LIMIT 1',
      [eventId],
    );
    return row?.decision ?? null;
  }

  // ------------------------------------------------------------------
  // Chains
  // ------------------------------------------------------------------

  insertChain(row: ChainRow): void {
    this.run(
      `INSERT INTO chains (id, agent, workspace_id, session_id, status, capsule_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.agent,
        row.workspace_id,
        row.session_id,
        row.status,
        row.capsule_id,
        row.created_at,
        row.updated_at,
      ],
    );
  }

  getChain(id: string): ChainRow | undefined {
    return this.queryOne<ChainRow>('SELECT * FROM chains WHERE id = ?', [id]);
  }

  addChainMember(chainId: string, eventId: string, position: number): void {
    this.transaction(() => {
      const chain = this.getChain(chainId);
      const event = this.getToolEvent(eventId);
      if (!chain || !event || chain.agent !== event.agent || chain.workspace_id !== event.workspace_id || chain.session_id !== event.session_id)
        throw new Error('chain member belongs to a different agent/workspace/session');
      if (event.chain_id && event.chain_id !== chainId)
        throw new Error('event already belongs to another chain');
      this.run('INSERT OR IGNORE INTO chain_members (chain_id, event_id, position) VALUES (?, ?, ?)', [
        chainId, eventId, position,
      ]);
    });
  }

  getChainMembers(chainId: string): string[] {
    const rows = this.queryAll<{ event_id: string }>(
      `SELECT m.event_id FROM chain_members m
       JOIN chains c ON c.id=m.chain_id JOIN tool_events e ON e.id=m.event_id
       WHERE m.chain_id=? AND e.agent=c.agent AND e.workspace_id=c.workspace_id AND e.session_id=c.session_id
       ORDER BY m.position ASC`,
      [chainId],
    );
    return rows.map((r) => r.event_id);
  }

  getChainEvents(chainId: string): ToolEventRow[] {
    return this.queryAll<ToolEventRow>(
      `SELECT e.* FROM tool_events e
         JOIN chain_members m ON m.event_id = e.id
         JOIN chains c ON c.id=m.chain_id
        WHERE m.chain_id = ? AND e.agent=c.agent AND e.workspace_id=c.workspace_id AND e.session_id=c.session_id
        ORDER BY m.position ASC`,
      [chainId],
    );
  }

  listChains(sessionId?: string): ChainRow[] {
    if (sessionId) {
      return this.queryAll<ChainRow>('SELECT * FROM chains WHERE session_id = ? ORDER BY created_at ASC', [
        sessionId,
      ]);
    }
    return this.queryAll<ChainRow>('SELECT * FROM chains ORDER BY created_at ASC');
  }

  updateChain(id: string, patch: Partial<ChainRow>): void {
    this.applyPatch('chains', id, patch as Record<string, unknown>);
  }

  // ------------------------------------------------------------------
  // Capsules
  // ------------------------------------------------------------------

  insertCapsule(row: CapsuleRow): void {
    this.run(
      `INSERT INTO capsules (id, source_event_ids_json, summary, facts_json, anchors_json, outcome, frozen, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.source_event_ids_json,
        row.summary,
        row.facts_json,
        row.anchors_json,
        row.outcome,
        row.frozen,
        row.created_at,
        row.updated_at,
      ],
    );
  }

  getCapsule(id: string): CapsuleRow | undefined {
    return this.queryOne<CapsuleRow>('SELECT * FROM capsules WHERE id = ?', [id]);
  }

  updateCapsule(id: string, patch: Partial<CapsuleRow>): void {
    this.applyPatch('capsules', id, patch as Record<string, unknown>);
  }

  listCapsules(limit = 100): CapsuleRow[] {
    return this.queryAll<CapsuleRow>('SELECT * FROM capsules ORDER BY created_at DESC LIMIT ?', [
      limit,
    ]);
  }

  // ------------------------------------------------------------------
  // Scores / decisions
  // ------------------------------------------------------------------

  insertRetentionScore(eventId: string, scorer: string, score: number, turn: number): void {
    this.run(
      'INSERT INTO retention_scores (event_id, scorer, safe_to_evict, turn, created_at) VALUES (?, ?, ?, ?, ?)',
      [eventId, scorer, score, turn, Date.now()],
    );
  }

  listScores(eventId?: string, limit = 100): RetentionScoreRow[] {
    if (eventId) {
      return this.queryAll<RetentionScoreRow>(
        'SELECT id, event_id, scorer, safe_to_evict, turn, created_at FROM retention_scores WHERE event_id = ? ORDER BY id DESC LIMIT ?',
        [eventId, limit],
      );
    }
    return this.queryAll<RetentionScoreRow>(
      'SELECT id, event_id, scorer, safe_to_evict, turn, created_at FROM retention_scores ORDER BY id DESC LIMIT ?',
      [limit],
    );
  }

  insertDecision(
    eventId: string,
    decision: string,
    reason: string,
    score: number | null,
    turn: number,
  ): void {
    this.run(
      'INSERT INTO decisions (event_id, decision, reason, score, turn, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [eventId, decision, reason, score, turn, Date.now()],
    );
  }

  listDecisions(limit = 100): DecisionRow[] {
    return this.queryAll<DecisionRow>(
      'SELECT id, event_id, decision, reason, score, turn, created_at FROM decisions ORDER BY id DESC LIMIT ?',
      [limit],
    );
  }

  lastDecisionTurn(eventId: string): number | null {
    const row = this.queryOne<{ max_turn: number | null }>(
      'SELECT MAX(turn) AS max_turn FROM decisions WHERE event_id = ?',
      [eventId],
    );
    return row?.max_turn ?? null;
  }

  // ------------------------------------------------------------------
  // Recalls
  // ------------------------------------------------------------------

  insertRecallLog(rec: {
    eventId: string;
    toolCallId: string;
    agent: string;
    workspaceId: string;
    turn: number;
    decisionTurn: number | null;
    turnsUntilRecall: number | null;
    safeToEvict?: number | null;
    decision?: string | null;
  }): void {
    this.run(
      `INSERT INTO recall_log (event_id, tool_call_id, agent, workspace_id, recalled_at, turn, decision_turn, turns_until_recall, safe_to_evict, decision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        rec.eventId,
        rec.toolCallId,
        rec.agent,
        rec.workspaceId,
        Date.now(),
        rec.turn,
        rec.decisionTurn,
        rec.turnsUntilRecall,
        rec.safeToEvict ?? null,
        rec.decision ?? null,
      ],
    );
  }

  listRecalls(limit = 100): RecallLogRow[] {
    return this.queryAll<RecallLogRow>(
      `SELECT id, event_id, tool_call_id, agent, workspace_id, recalled_at, turn, decision_turn, turns_until_recall, safe_to_evict, decision
         FROM recall_log ORDER BY id DESC LIMIT ?`,
      [limit],
    );
  }

  // ------------------------------------------------------------------
  // Pins
  // ------------------------------------------------------------------

  insertPin(
    targetType: 'event' | 'chain',
    targetId: string,
    sessionId: string | null,
    persistent: boolean,
  ): void {
    // SQLite treats NULLs as distinct in UNIQUE constraints, so a
    // NULL-session pin would never conflict: delete the existing one first
    // to keep pin-per-(target, session) semantics.
    if (sessionId === null) {
      this.run(
        'DELETE FROM pins WHERE target_type = ? AND target_id = ? AND session_id IS NULL',
        [targetType, targetId],
      );
    }
    this.run(
      `INSERT OR REPLACE INTO pins (target_type, target_id, session_id, persistent, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [targetType, targetId, sessionId, persistent ? 1 : 0, Date.now()],
    );
  }

  /**
   * Delete pins for a target. sessionId === undefined removes the pin in
   * every session; otherwise only that session's pin (null = global pin).
   */
  deletePin(targetType: string, targetId: string, sessionId?: string | null): void {
    if (sessionId === undefined) {
      this.run('DELETE FROM pins WHERE target_type = ? AND target_id = ?', [
        targetType,
        targetId,
      ]);
    } else if (sessionId === null) {
      this.run(
        'DELETE FROM pins WHERE target_type = ? AND target_id = ? AND session_id IS NULL',
        [targetType, targetId],
      );
    } else {
      this.run('DELETE FROM pins WHERE target_type = ? AND target_id = ? AND session_id = ?', [
        targetType,
        targetId,
        sessionId,
      ]);
    }
  }

  /** All pins for one target (used for session-scoped protection checks). */
  listPinsForTarget(targetType: string, targetId: string): PinRow[] {
    return this.queryAll<PinRow>(
      'SELECT id, target_type, target_id, session_id, persistent, created_at FROM pins WHERE target_type = ? AND target_id = ? ORDER BY id ASC',
      [targetType, targetId],
    );
  }

  listPins(): PinRow[] {
    return this.queryAll<PinRow>(
      'SELECT id, target_type, target_id, session_id, persistent, created_at FROM pins ORDER BY id ASC',
    );
  }

  isPinned(targetType: string, targetId: string): boolean {
    const row = this.queryOne<{ one: number }>(
      'SELECT 1 AS one FROM pins WHERE target_type = ? AND target_id = ? LIMIT 1',
      [targetType, targetId],
    );
    return row !== undefined;
  }

  // ------------------------------------------------------------------
  // Provider calls
  // ------------------------------------------------------------------

  insertProviderCall(rec: ProviderCallRecord): void {
    this.run(
      `INSERT INTO provider_calls (provider, model, purpose, tokens_in, tokens_out, cost_usd, ok, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        rec.provider,
        rec.model,
        rec.purpose,
        rec.tokensIn,
        rec.tokensOut,
        rec.costUsd,
        rec.ok ? 1 : 0,
        rec.error ?? null,
        Date.now(),
      ],
    );
  }

  listProviderCalls(limit = 100): ProviderCallRow[] {
    return this.queryAll<ProviderCallRow>(
      `SELECT id, provider, model, purpose, tokens_in, tokens_out, cost_usd, ok, error, created_at
         FROM provider_calls ORDER BY id DESC LIMIT ?`,
      [limit],
    );
  }

  // ------------------------------------------------------------------
  // Stats
  // ------------------------------------------------------------------

  bumpStat(key: string, delta = 1): void {
    this.run(
      `INSERT INTO stats (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = value + excluded.value`,
      [key, delta],
    );
  }

  setStat(key: string, value: number): void {
    this.run(
      `INSERT INTO stats (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  }

  getStats(): Record<string, number> {
    const rows = this.queryAll<{ key: string; value: number }>('SELECT key, value FROM stats');
    const out: Record<string, number> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  }

  // ------------------------------------------------------------------
  // Audit
  // ------------------------------------------------------------------

  insertAudit(toolName: string, sessionId: string | null, note: string): void {
    this.run('INSERT INTO audit_log (tool_name, session_id, created_at, note) VALUES (?, ?, ?, ?)', [
      toolName,
      sessionId,
      Date.now(),
      note,
    ]);
  }

  countAudits(): number {
    const row = this.queryOne<{ n: number }>('SELECT COUNT(*) AS n FROM audit_log');
    return row?.n ?? 0;
  }

  // ------------------------------------------------------------------
  // Host usage
  // ------------------------------------------------------------------

  setHostUsage(sessionId: string, contextWindow: number, usedTokens: number, managedTokens = 0): void {
    this.run(`INSERT OR REPLACE INTO host_usage(session_id,context_window,used_tokens,updated_at,managed_tokens) VALUES(?,?,?,?,?)`,
      [sessionId,contextWindow,usedTokens,Date.now(),managedTokens]);
  }
  getHostUsage(sessionId: string): {context_window: number; used_tokens: number; managed_tokens: number} | undefined {
    return this.queryOne('SELECT context_window,used_tokens,managed_tokens FROM host_usage WHERE session_id = ?', [sessionId]);
  }

  // ------------------------------------------------------------------
  // Introspection
  // ------------------------------------------------------------------

  tableExists(name: string): boolean {
    const row = this.queryOne<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
      [name],
    );
    return row !== undefined;
  }
}
