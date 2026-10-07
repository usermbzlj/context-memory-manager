/**
 * Deterministic conservative fallback scorer (PRD §10).
 *
 * Used whenever the model-backed scorer is unavailable (no providers,
 * total provider failure). It is deliberately stingy: on fallback only
 * extremely safe content may compress, so the scorer NEVER returns above
 * 0.85 and penalises errors, test failures, side effects, and recency.
 */

import type {
  RetentionScorer,
  ScorerContext,
  ToolEvent,
} from '../types.js';
import { clampScore } from './scorer.js';

const MAX_FALLBACK_SCORE = 0.85;

export class ConservativeFallbackScorer implements RetentionScorer {
  readonly name = 'conservative-fallback';

  async score(event: ToolEvent, ctx: ScorerContext): Promise<number> {
    let score = 0.35;
    const age = ctx.currentTurn - event.turn;

    if (event.resultRef.bytes > 48 * 1024) score += 0.25;
    if (event.status === 'ok' && age > 10) score += 0.15;
    if (
      event.resultRef.bytes > 8 * 1024 &&
      event.descriptor.salient.length === 0
    ) {
      score += 0.1;
    }

    if (event.status === 'error') score -= 0.3;
    if (
      event.descriptor.testVerdict !== undefined &&
      /[1-9]\d*\s+failed/.test(event.descriptor.testVerdict)
    ) {
      score -= 0.2;
    }
    if (event.descriptor.isSideEffect) score -= 0.15;
    if (event.descriptor.paths.length > 0 && age <= 5) score -= 0.1;

    return Math.min(clampScore(score), MAX_FALLBACK_SCORE);
  }
}
