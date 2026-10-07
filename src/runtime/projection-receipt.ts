import type { Database } from '../storage/sqlite.js';
import type { ToolEventRow } from '../types.js';
import { sha256 } from '../storage/blob-store.js';
import { utf8 } from '../util/validation.js';

export interface ProjectionReceipt {
  event_id: string;
  session_id: string;
  mode: string;
  representation: string;
  source_sha: string;
  visible_sha: string;
  text: string;
}

export function projectionSource(result: string, representation: string): string {
  if (representation === 'text') return result;
  if (representation !== 'stdout' && representation !== 'mcp-text')
    throw new Error('Unsupported projection representation');
  const value = JSON.parse(result);
  if (representation === 'stdout' && typeof value?.stdout === 'string') return value.stdout;
  if (representation === 'mcp-text' && Array.isArray(value?.content) &&
      value.content.every((part: any) => part?.type === 'text' && typeof part.text === 'string'))
    return value.content.map((part: {text: string}) => part.text).join('\n');
  throw new Error('Archived result does not match the projection representation');
}

/** Read-only validation shared by use and diagnostics. Hash integrity is not authentication. */
export function validateProjectionReceipt(db: Database, row: ToolEventRow, receipt: ProjectionReceipt, result: string): void {
  if (receipt.event_id !== row.id || !['ingress', 'history'].includes(receipt.mode))
    throw new Error('Projection receipt has invalid event or mode');
  const session = db.getSession(receipt.session_id);
  if (!session || session.agent !== row.agent || session.workspace_id !== row.workspace_id ||
      (receipt.session_id !== row.session_id && !db.getEventView(row.id, receipt.session_id)))
    throw new Error('Projection receipt has invalid session scope or missing event view');
  utf8(receipt.text, 'projection receipt');
  const source = projectionSource(result, receipt.representation);
  utf8(source, 'projection source');
  if (sha256(source) !== receipt.source_sha || sha256(receipt.text) !== receipt.visible_sha)
    throw new Error('Projection receipt integrity mismatch; leaving host output unchanged');
}
