import { inferProvenance } from '../evidence/provenance.js';
import { indexEvidence } from '../evidence/index.js';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Database } from './sqlite.js';
import { BlobStore, sha256 } from './blob-store.js';
import { rowToToolEvent, ArchiveError, RecallError } from '../types.js';
import type { ArchiveService, ContentRef, Logger, ToolEvent, ToolEventInput, ToolDescriptor, ToolEventRow } from '../types.js';
import { text, utf8 } from '../util/validation.js';

export function normalizeWorkspaceId(workspaceId: string): string {
  if (!/[\\/]/.test(workspaceId) && !workspaceId.startsWith('~') && !workspaceId.startsWith('.')) return workspaceId;
  let expanded = workspaceId;
  if (expanded === '~' || expanded.startsWith('~/') || expanded.startsWith('~\\'))
    expanded = path.join(os.homedir(), expanded.slice(1));
  const explicitWindows = /^[a-zA-Z]:[\\/]/.test(expanded) || expanded.startsWith('\\\\');
  const windows = process.platform === 'win32' || explicitWindows;
  const paths = windows ? path.win32 : path;
  let normalized = explicitWindows ? paths.normalize(expanded) : paths.resolve(expanded);
  if (process.platform === 'win32' || !explicitWindows) {
    try { normalized = fs.realpathSync.native(normalized); }
    catch {
      // Canonicalize an available parent too: a not-yet-created project below
      // a differently-cased parent or junction keeps the same identity later.
      if (process.platform === 'win32') {
        const suffix: string[] = [];
        let candidate = normalized;
        while (paths.dirname(candidate) !== candidate) {
          suffix.unshift(paths.basename(candidate));
          candidate = paths.dirname(candidate);
          try { normalized = paths.join(fs.realpathSync.native(candidate), ...suffix); break; }
          catch { /* Try the next existing parent without inventing its case. */ }
        }
      }
    }
  }
  normalized = paths.normalize(normalized);
  // Apply one drive policy last, including after realpath and native resolve.
  // Path components keep their spelling; case-sensitive directories stay distinct.
  if (windows) normalized = normalized.replace(/^([A-Z]):/, (_, drive: string) => `${drive.toLowerCase()}:`);
  const root = paths.parse(normalized).root;
  return normalized.length > root.length ? normalized.replace(windows ? /\\$/ : /\/$/, '') : normalized;
}
/** Preserve a unique legacy Windows spelling without rewriting archive identities. */
export function resolveWorkspaceId(db: Database, agent: string, requested: string, shared = false): string {
  const canonical = normalizeWorkspaceId(requested);
  if (!/^[a-z]:\\/.test(canonical) && !canonical.startsWith('\\\\')) return canonical;
  // Windows drive letters and UNC server/share names identify the volume.
  // Their case is immaterial; directory components remain case-sensitive here.
  const comparisonKey = (id: string): string => {
    const root = path.win32.parse(id).root;
    return root.toLowerCase() + id.slice(root.length);
  };
  const key = comparisonKey(canonical);
  // Legacy paths can also precede parent creation or spell an existing junction.
  // Verify candidates through the same filesystem policy, never case-fold the
  // entire identifier to authorize access to a different case-sensitive path.
  // A different volume can contain another junction alias, so do not exclude
  // it before verification: doing so could silently miss a legacy conflict.
  const matches = db.queryAll<{id: string}>(
    `SELECT DISTINCT id FROM workspaces${shared ? '' : ' WHERE agent=?'}`,
    shared ? [] : [agent]).filter(row => row.id === requested || row.id === canonical ||
      comparisonKey(normalizeWorkspaceId(row.id)) === key);
  if (matches.length > 1) throw new Error('Conflicting legacy workspace identities; archives were not merged or rewritten');
  return matches[0]?.id ?? canonical;
}

export function validateToolInput(input: ToolEventInput): void {
  for (const k of ['agent', 'workspaceId', 'sessionId', 'toolCallId', 'toolName'] as const) text(input[k], k);
  utf8(input.input, 'input'); utf8(input.result, 'result');
  if (input.status !== 'ok' && input.status !== 'error') throw new ArchiveError('status must be ok or error');
}
/** Search is bounded evidence indexing, not another full copy of large blobs. */
export function searchBody(input: string, result: string, descriptor: ToolDescriptor): string {
  return [JSON.stringify(descriptor), input.slice(0,8192), result.slice(0,16384), result.length > 16384 ? result.slice(-16384) : ''].join('\n');
}
export class ArchiveServiceImpl implements ArchiveService {
  private failNext = false;
  private readonly remoteCaptured = new Set<string>();
  constructor(private readonly db: Database, private readonly blobs: BlobStore, private readonly logger?: Logger) {}
  failNextArchive(): void { this.failNext = true; }
  private captureGitRemote(agent: string, workspace: string): void {
    const key = `${agent}\0${workspace}`;
    if (this.remoteCaptured.has(key)) return;
    this.remoteCaptured.add(key);
    try {
      if (!fs.existsSync(workspace)) return;
      const url = execFileSync('git', ['-C', workspace, 'remote', 'get-url', 'origin'],
        { timeout: 500, stdio: ['ignore','pipe','ignore'], windowsHide: true }).toString().trim();
      if (url) this.db.run('UPDATE workspaces SET git_remote = ? WHERE agent = ? AND id = ?', [url, agent, workspace]);
    } catch { /* Optional metadata, never a requirement for archival. */ }
  }
  async archive(input: ToolEventInput, turn: number, descriptor: ToolDescriptor): Promise<ToolEvent & { inserted: boolean }> {
    if (this.failNext) { this.failNext = false; throw new ArchiveError('injected archive failure'); }
    validateToolInput(input);
    let workspaceId = normalizeWorkspaceId(input.workspaceId);
    const provenance = inferProvenance(input);
    try {
      const saved = this.db.transaction(() => {
        workspaceId = resolveWorkspaceId(this.db, input.agent, input.workspaceId);
        this.db.ensureAgent(input.agent);
        this.db.ensureWorkspace(input.agent, workspaceId, workspaceId);
        this.db.ensureSession(input.agent, workspaceId, input.sessionId);
        const old = this.db.getToolEventByCallId(input.agent, workspaceId, input.toolCallId, input.sessionId);
        if (old) {
          if (old.input_sha !== sha256(input.input) || old.result_sha !== sha256(input.result)
            || old.tool_name !== input.toolName || old.status !== input.status) {
            throw new ArchiveError('archive identity conflict: the same tool call has different content; original preserved');
          }
          this.readRow(old); // A duplicate must still have readable, verified originals.
          return { ...rowToToolEvent(old), inserted: false };
        }
        // Files and references share the writer lock with GC. A new writer cannot
        // publish a reference while GC is deciding whether to unlink its blob.
        const inputRef = this.blobs.put(input.input);
        const resultRef = this.blobs.put(input.result);
        const now = Date.now();
        const row: ToolEventRow = {
          id: randomUUID(), agent: input.agent, workspace_id: workspaceId,
          session_id: input.sessionId, tool_call_id: input.toolCallId, tool_name: input.toolName,
          status: input.status, turn: turn > 0 ? turn : this.db.bumpTurn(input.sessionId), created_at: now, archived_at: now,
          input_kind: inputRef.kind, input_ref: inputRef.ref, input_sha: inputRef.sha256, input_bytes: inputRef.bytes,
          result_kind: resultRef.kind, result_ref: resultRef.ref, result_sha: resultRef.sha256, result_bytes: resultRef.bytes,
          descriptor_json: JSON.stringify(descriptor), chain_id: null, pinned: 0, persistent_pin: 0,
          state: 'hot', safe_to_evict: null, protected_until_turn: 0, recalled_count: 0, last_recalled_at: null, capsule_id: null,
        };
        this.db.insertToolEvent(row);
        this.db.run('INSERT INTO evidence_provenance(event_id,json) VALUES(?,?)', [row.id, JSON.stringify(provenance)]);
        indexEvidence(this.db, row.id, input.input, input.result);
        this.db.run('INSERT INTO archive_search(event_id,agent,workspace,tool,body) VALUES(?,?,?,?,?)',
          [row.id, input.agent, workspaceId, input.toolName, searchBody(input.input, input.result, descriptor)]);
        return { ...rowToToolEvent(row), inserted: true };
      });
      this.captureGitRemote(input.agent, workspaceId);
      return saved;
    } catch (error) {
      if (error instanceof ArchiveError) throw error;
      throw new ArchiveError(`archive write failed: ${error instanceof Error ? error.message : String(error)}`, {cause: error});
    }
  }
  private readRow(row: ToolEventRow): {input: string; result: string} {
    return {
      input: this.blobs.get({kind: row.input_kind, ref: row.input_ref, sha256: row.input_sha, bytes: row.input_bytes}),
      result: this.blobs.get({kind: row.result_kind, ref: row.result_ref, sha256: row.result_sha, bytes: row.result_bytes}),
    };
  }
  async fetchOriginal(eventId: string): Promise<{input: string; result: string}> {
    const row = this.db.getToolEvent(eventId);
    if (!row) {
      const deleted = this.db.queryOne('SELECT event_id FROM archive_tombstones WHERE event_id = ?', [eventId]);
      throw new RecallError(deleted ? `event ${eventId} was explicitly deleted by archive GC` : `event not found: ${eventId}`);
    }
    return this.readRow(row);
  }
  deleteUnreferencedBlob(ref: ContentRef, excludeEventId: string): boolean {
    if (ref.kind !== 'blob') return false;
    return this.db.transaction(() => {
      if (this.db.countShaReferences(ref.sha256, excludeEventId) > 0) return false;
      return this.blobs.deleteBlob(ref.ref);
    });
  }
}
