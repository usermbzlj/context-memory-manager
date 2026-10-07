import type { Database } from '../storage/sqlite.js';
import type { ChainRow, ToolEventRow } from '../types.js';

export type ProtectionReason = 'pinned' | 'recall-protection' | 'chain-active';

/** A source chain is not a mutable chain identity for a recalled session view. */
export function scopedEventChain(db: Database, row: ToolEventRow, sessionId = row.session_id): ChainRow | undefined {
  if (!row.chain_id || row.session_id !== sessionId) return undefined;
  const chain = db.getChain(row.chain_id);
  return chain && chain.agent === row.agent && chain.workspace_id === row.workspace_id && chain.session_id === sessionId
    ? chain : undefined;
}

/**
 * Re-read mutable protections for the selected session view. Call again inside
 * the publication transaction after any asynchronous scoring or extraction.
 * protected_until_turn includes both recall and adapter first-use protection.
 */
export function eventProtectionReason(
  db: Database, row: ToolEventRow, minProtectionTurns: number,
  sessionId = row.session_id, currentTurn = db.getCurrentTurn(sessionId),
): ProtectionReason | undefined {
  const pinned = (type: 'event' | 'chain', id: string): boolean =>
    db.listPinsForTarget(type, id).some(pin => pin.session_id === null || pin.session_id === sessionId);
  if (pinned('event', row.id)) return 'pinned';
  // Explicit source-membership pins protect this same evidence in their pin
  // scope. Reading that association does not give a recalled view a mutable
  // source-chain identity or its source-session freshness counter.
  const source = db.getToolEvent(row.id);
  const sourceChain = source && source.agent === row.agent && source.workspace_id === row.workspace_id
    ? scopedEventChain(db, source) : undefined;
  if (sourceChain && pinned('chain', sourceChain.id) && db.getChainMembers(sourceChain.id).includes(row.id)) return 'pinned';
  const chain = scopedEventChain(db, row, sessionId);
  if (row.session_id === sessionId && currentTurn < row.protected_until_turn) return 'recall-protection';
  if (!chain || chain.status !== 'active') return undefined;
  // Database membership readers exclude legacy members from foreign scopes.
  const members = db.getChainEvents(chain.id);
  if (!members.some(member => member.id === row.id)) return undefined;
  let newestTurn = row.turn;
  for (const member of members) newestTurn = Math.max(newestTurn, member.turn);
  return currentTurn - newestTurn <= minProtectionTurns ? 'chain-active' : undefined;
}
