import type { Database } from '../storage/sqlite.js';
import { safeEnd } from '../util/text.js';
export { safeEnd } from '../util/text.js';

export const INDEX_CHAR_LIMIT = 8 * 1024 * 1024;
const CHUNK_CHARS = 4096;
const OVERLAP = 1024;

/** Bounded full-payload indexing; manifests explicitly disclose unindexed tails. */
export function indexEvidence(db: Database, eventId: string, input: string, result: string): void {
  db.run('DELETE FROM evidence_chunks WHERE event_id=?', [eventId]);
  db.run('DELETE FROM evidence_index WHERE event_id=?', [eventId]);
  for (const [field, content] of [['input', input], ['result', result]] as const) {
    const indexed = safeEnd(content, Math.min(INDEX_CHAR_LIMIT, content.length));
    let offset = 0;
    while (offset < indexed) {
      const end = safeEnd(content, Math.min(indexed, offset + CHUNK_CHARS));
      db.run('INSERT INTO evidence_chunks(event_id,field,start_offset,end_offset,body) VALUES(?,?,?,?,?)',
        [eventId, field, offset, end, content.slice(offset,end).replaceAll('\0',' ')]);
      if (end === indexed) break;
      offset = safeEnd(content, end - OVERLAP);
    }
    db.run('INSERT INTO evidence_index(event_id,field,indexed_chars,total_chars,version) VALUES(?,?,?,?,1)',
      [eventId,field,indexed,content.length]);
  }
}

export function indexCoverage(db: Database, eventId: string) {
  const fields = db.queryAll<{field: string; indexed_chars: number; total_chars: number}>(
    'SELECT field,indexed_chars,total_chars FROM evidence_index WHERE event_id=? ORDER BY field', [eventId]);
  return {status: fields.length === 2 ? fields.every(f => f.indexed_chars === f.total_chars) ? 'full' : 'partial' : 'legacy-needs-reindex',
    fields, offsetUnit: 'UTF-16 code units'};
}
