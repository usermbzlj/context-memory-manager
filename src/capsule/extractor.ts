/**
 * Deterministic capsule-draft extraction (PRD §11).
 *
 * A capsule is NEVER a source of truth: it may only contain facts copied
 * from the event's descriptor (salient lines, exit code, test verdict,
 * paths). The cheap model later refines this draft, but validation in
 * CapsuleBuilderImpl drops anything it invents.
 */

import type { CapsuleDraft, ToolEvent } from '../types.js';
import { truncateText } from '../util/text.js';

export function extractCapsuleDraft(event: ToolEvent): CapsuleDraft {
  const d = event.descriptor;

  const summaryBase =
    d.inputSummary +
    (d.outcome ? ` → ${d.outcome}` : '') +
    (event.status === 'error' ? ' (error)' : '');
  const summary = truncateText(summaryBase, 300);

  const facts: string[] = [];

  if (d.exitCode !== undefined) facts.push(`exit code: ${d.exitCode}`);
  if (d.testVerdict) facts.push(`tests: ${d.testVerdict}`);
  if (d.isSideEffect) facts.push(`side effect: ${d.tool}`);
  for (const s of d.salient.slice(0, 10)) facts.push(s);
  const dedupedFacts = [...new Set(facts)].slice(0, 12);

  const anchors = [...new Set(d.paths)].slice(0, 12);

  return {
    summary,
    facts: dedupedFacts,
    anchors,
    ...(d.outcome !== undefined ? { outcome: d.outcome } : {}),
  };
}
