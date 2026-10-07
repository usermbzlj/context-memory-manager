import type { ToolEventInput } from '../types.js';
import type { Database } from '../storage/sqlite.js';

/** Completeness describes the upstream capture, not whether our hash verifies. */
export interface EvidenceProvenance {
  version: 1;
  origin: 'tool-observation' | 'upstream-filtered' | 'rtk-recall' | 'file-import' | 'legacy';
  captureStage: 'host-result' | 'mcp-result' | 'rtk-store' | 'file' | 'unknown';
  completeness: 'unknown' | 'complete' | 'partial';
  upstream?: { system: 'rtk' | 'unknown'; reference?: string; sourceDigest?: string };
  notes: string[];
}

export const LEGACY_PROVENANCE: EvidenceProvenance = {
  version: 1, origin: 'legacy', captureStage: 'unknown', completeness: 'unknown',
  notes: ['Recorded before provenance tracking. Hash verification covers captured bytes only.'],
};

export function inferProvenance(input: Pick<ToolEventInput, 'input' | 'result' | 'provenance'>): EvidenceProvenance {
  let provenance: EvidenceProvenance = input.provenance ? validateProvenance(input.provenance) : {
    version: 1, origin: 'tool-observation', captureStage: 'unknown', completeness: 'unknown', notes: [],
  };
  // Detection only. Never execute recovery hints or paths found in untrusted output.
  const hint = input.result.match(/\[(?:full output:|\+\d+ hidden:)\s*rtk recall ([a-f0-9]{12,64})\]/i);
  let command = input.input;
  try {
    const parsed: unknown = JSON.parse(input.input);
    if (parsed && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>).command === 'string')
      command = (parsed as { command: string }).command;
  } catch { /* Plain text tool input is normal. */ }
  const rtkCommand = /(?:^|[\s"'\\/])rtk(?:\.exe)?(?:["']?\s)/i.test(command);
  if (provenance.origin !== 'rtk-recall' && (hint || rtkCommand)) {
    provenance = {version: 1, origin: 'upstream-filtered', captureStage: provenance.captureStage,
      completeness: provenance.completeness === 'partial' ? 'partial' : 'unknown', upstream: {system: 'rtk', ...(hint ? {reference: hint[1].toLowerCase()} : {})},
      notes: ['Possible RTK-filtered result. This archive is the observed result, not proof of the pre-filter output.']};
  }
  if (provenance.origin !== 'rtk-recall' && /(?:\[\s*\d+ characters truncated\s*\]|output (?:was )?truncated|\[truncated\])/i.test(input.result)) {
    provenance = {...provenance, completeness: 'partial',
      notes: [...provenance.notes, 'A truncation marker was observed; omitted bytes are not in this archive.']};
  }
  return provenance;
}

export function validateProvenance(value: EvidenceProvenance): EvidenceProvenance {
  if (!value || value.version !== 1 ||
    !['tool-observation','upstream-filtered','rtk-recall','file-import','legacy'].includes(value.origin) ||
    !['host-result','mcp-result','rtk-store','file','unknown'].includes(value.captureStage) ||
    !['unknown','complete','partial'].includes(value.completeness) ||
    !Array.isArray(value.notes) || value.notes.length > 8 || value.notes.some(n => typeof n !== 'string' || n.length > 1000))
    throw new Error('Invalid evidence provenance');
  if (value.upstream && (!['rtk','unknown'].includes(value.upstream.system) ||
    (value.upstream.reference !== undefined && !/^[a-f0-9]{12,64}$/.test(value.upstream.reference)) ||
    (value.upstream.sourceDigest !== undefined && !/^[a-f0-9]{64}$/.test(value.upstream.sourceDigest))))
    throw new Error('Invalid upstream reference');
  return structuredClone(value);
}

export function provenanceFor(db: Database, eventId: string): EvidenceProvenance {
  const row = db.queryOne<{json: string}>('SELECT json FROM evidence_provenance WHERE event_id=?', [eventId]);
  return row ? validateProvenance(JSON.parse(row.json) as EvidenceProvenance) : structuredClone(LEGACY_PROVENANCE);
}

export function evidenceNotice(provenance: EvidenceProvenance): string {
  if (provenance.origin === 'upstream-filtered') return 'Exact observed filtered output; pre-filter original NOT captured.';
  if (provenance.completeness === 'partial') return 'Exact stored portion only; upstream content was truncated.';
  if (provenance.origin === 'rtk-recall') return 'Copied RTK store payload; complete according to that store, not a re-execution or independent source attestation.';
  return 'Exact captured text; completeness before the observation boundary is unknown.';
}
