/** Read-only compatibility adapter for RTK v0.50.0's recall store.
 * No RTK code is embedded and no hint, command or executable is ever run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import { sha256 } from '../storage/blob-store.js';
import { normalizeWorkspaceId } from '../storage/archive.js';
import type { MemoryService } from '../runtime/memory.js';
import type { EvidenceProvenance } from '../evidence/provenance.js';

const MAX_PAYLOAD = 32 * 1024 * 1024;
interface RtkRow {
  hash: string; command: string; cwd: string|null; exit_code: number|null; created_at: number;
  total_lines: number; shown_upto: number; byte_size: number; truncated: number;
  codec: string; blob: Uint8Array;
}
export interface RtkImportOptions {database: string; hash: string; workspace: string; sessionId?: string}

function sameWorkspace(root: string, cwd: string): boolean {
  const a=normalizeWorkspaceId(root), b=normalizeWorkspaceId(cwd);
  const paths=/^[a-zA-Z]:[\\/]/.test(a) || a.startsWith('\\\\') ? path.win32 : path;
  const relative=paths.relative(a,b);
  return relative !== '..' && !relative.startsWith('..'+paths.sep) && !paths.isAbsolute(relative);
}

export function readRtkEvidence(options: RtkImportOptions) {
  if (!/^[a-f0-9]{12}$/.test(options.hash)) throw new Error('RTK reference must be exactly 12 lowercase hex characters');
  const database=path.resolve(options.database);
  if (!fs.statSync(database).isFile()) throw new Error('RTK database must be an existing file');
  // Never create/migrate/evict rows or increment RTK recall/telemetry counters.
  const db=new DatabaseSync(database,{readOnly:true});
  let row:RtkRow;
  try {
    db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1000; BEGIN;');
    const kind=db.prepare("SELECT type FROM sqlite_master WHERE name='recall'").get() as {type:string}|undefined;
    if (kind?.type !== 'table') throw new Error('Unsupported RTK schema: recall must be an ordinary table');
    const columns=new Set((db.prepare('PRAGMA table_info(recall)').all() as {name:string}[]).map(r=>r.name));
    const required=['hash','command','cwd','exit_code','created_at','total_lines','shown_upto','byte_size','truncated','codec','blob'];
    if (required.some(c=>!columns.has(c))) throw new Error('Unsupported RTK recall schema; no import performed');
    const size=db.prepare('SELECT length(blob) AS bytes FROM recall WHERE hash=?').get(options.hash) as {bytes:number}|undefined;
    if (!size) throw new Error('RTK reference not found (it may have expired or been evicted)');
    if (!Number.isSafeInteger(size.bytes) || size.bytes < 0 || size.bytes > MAX_PAYLOAD) throw new Error('RTK stored payload exceeds the 32 MiB import bound');
    row=db.prepare('SELECT hash,command,cwd,exit_code,created_at,total_lines,shown_upto,byte_size,truncated,codec,blob FROM recall WHERE hash=?').get(options.hash) as unknown as RtkRow;
    db.exec('ROLLBACK;');
  } finally {db.close();}
  if (typeof row.cwd !== 'string' || !sameWorkspace(options.workspace,row.cwd))
    throw new Error('RTK row has no matching workspace provenance; refusing a cross-project import');
  if (typeof row.command !== 'string' || row.command.length > 65536 || row.command.includes('\0') ||
      ![0,1].includes(row.truncated) || !Number.isSafeInteger(row.byte_size) || row.byte_size < 0 ||
      !Number.isSafeInteger(row.total_lines) || row.total_lines < 0 || !Number.isSafeInteger(row.shown_upto) || row.shown_upto < 1 ||
      !Number.isSafeInteger(row.created_at) || row.created_at < 0 ||
      (row.exit_code !== null && !Number.isSafeInteger(row.exit_code)) || !(row.blob instanceof Uint8Array))
    throw new Error('Invalid RTK row metadata');
  if (!['raw','gzip'].includes(row.codec)) throw new Error('Unsupported RTK blob codec');
  const payload=row.codec==='gzip' ? gunzipSync(row.blob,{maxOutputLength:MAX_PAYLOAD}) : Buffer.from(row.blob);
  if (payload.length > MAX_PAYLOAD || payload.length > row.byte_size) throw new Error('RTK payload size is invalid');
  const lineCount=payload.length===0 ? 0 : payload.reduce((n,b)=>n+(b===10?1:0),0)+(payload.at(-1)===10?0:1);
  if (lineCount!==row.total_lines) throw new Error('RTK payload line count is invalid');
  const full=!row.truncated;
  if (full && (payload.length!==row.byte_size || sha256(Buffer.concat([Buffer.from(row.command),Buffer.from([0]),payload])).slice(0,12)!==row.hash))
    throw new Error('RTK source hash/length mismatch; no trustworthy full payload to import');
  // TextDecoder strips a leading BOM unless ignoreBOM is true: keep exact UTF-8 bytes.
  const exact=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(payload);
  const digest=sha256(payload);
  const provenance:EvidenceProvenance={version:1,origin:'rtk-recall',captureStage:'rtk-store',completeness:full?'complete':'partial',
    upstream:{system:'rtk',reference:row.hash,sourceDigest:digest},notes:[
      full ? 'RTK reports no truncation; its command+payload hash and original byte length were checked.' :
        'RTK truncated this entry. The payload can be a hidden tail, not a prefix; original line positions and the full source hash cannot be reconstructed.',
      'Command metadata is RTK filter metadata, not proof of the original shell arguments. Import copies the stored payload only.',
    ]};
  const metadata={reference:row.hash,cwd:row.cwd,filter:row.command,createdAtSeconds:row.created_at,
    exitCode:row.exit_code,reportedOriginalBytes:row.byte_size,storedBytes:payload.length,
    shownFromLine:row.shown_upto,sourceHashValidated:full,sha256:digest,provenance};
  return {metadata,result:exact,provenance};
}

export async function importRtkEvidence(service: MemoryService, options: RtkImportOptions) {
  if (normalizeWorkspaceId(options.workspace)!==normalizeWorkspaceId(service.scope.workspaceId)) throw new Error('Import workspace must match the selected archive scope');
  if (service.scope.shared) throw new Error('RTK import requires a single agent scope');
  const data=readRtkEvidence(options);
  const saved=await service.capture({sessionId:options.sessionId ?? `rtk-import:${options.hash}`,
    toolCallId:`rtk:${options.hash}:${data.metadata.sha256}`,toolName:'rtk.recall',
    input:JSON.stringify({reference:options.hash,filter:data.metadata.filter,cwd:data.metadata.cwd}),
    result:data.result,status:data.metadata.exitCode!==null && data.metadata.exitCode!==0?'error':'ok',
    provenance:data.provenance},'rtk:import');
  return {...saved,source:data.metadata,notice:'Imported a copy. RTK database, eviction settings and original host event were not modified.'};
}
