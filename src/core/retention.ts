import type {
  BatchScoreItem,
  CapsuleBuilder,
  DecisionDetail,
  Logger,
  RetentionDecision,
  RetentionScorer,
  ScorerContext,
  StrategyPreset,
  ToolDescriptor,
  ToolEvent,
} from '../types.js';
import { rowToToolEvent } from '../types.js';
import type { Database } from '../storage/sqlite.js';
import { eventProtectionReason, scopedEventChain } from './protection.js';

/**
 * Retention engine: decides KEEP / CAPSULE / EVICT for HOT events.
 *
 * Protection layers (evaluated before any scoring):
 *   1. DB-backed pin protection: pins on the event or its chain (global or
 *      session-scoped) always keep the event HOT.
 *   2. recall protection: recently recalled events stay HOT until
 *      protectedUntilTurn (invariant §7.3).
 *   3. chain-active protection: events in an ACTIVE chain are kept while the
 *      chain is fresh (currentTurn - newestMemberTurn <= minProtectionTurns).
 *
 * Scoring: batched primary scoring (Jev) with deterministic fallback on
 * failure. Scores from the fallback are never trusted enough to evict —
 * they are capped at CAPSULE. The model score is also clamped by a decision
 * floor: side-effect tools and failed (error) events are NEVER silently
 * evicted — at minimum they are capsuled (PRD §7.4, §12).
 */

/** Per-event plan built in phase 1 of decideAll. */
type DecisionPlan =
  | { kind: 'keep'; event: ToolEvent; currentTurn: number; reason: string }
  | {
      kind: 'score';
      event: ToolEvent;
      currentTurn: number;
      sctx: ScorerContext;
    };

type ScorePlan = Extract<DecisionPlan, { kind: 'score' }>;

interface ScoredInfo {
  score: number;
  scorerName: string;
  usedFallback: boolean;
  /** Defensive: the fallback scorer threw; decide KEEP without a score. */
  forceKeep: boolean;
}

export class RetentionEngine {
  /** Public so tests / operators can swap the scoring stack. */
  primary: RetentionScorer;
  /** Public so tests / operators can swap the scoring stack. */
  fallback: RetentionScorer;

  private readonly db: Database;
  private readonly capsules: CapsuleBuilder;
  private readonly logger: Logger;
  private readonly preset: StrategyPreset;
  private readonly verifyArchive?: (id: string) => Promise<unknown>;
  private readonly getTurn: (sessionId: string) => number;
  private readonly floorOrder: Record<RetentionDecision, number> = {
    keep: 0,
    capsule: 1,
    evict: 2,
  };

  constructor(opts: {
    db: Database;
    primary: RetentionScorer;
    fallback: RetentionScorer;
    capsules: CapsuleBuilder;
    logger: Logger;
    preset: StrategyPreset;
    getTurn: (sessionId: string) => number;
    verifyArchive?: (id: string) => Promise<unknown>;
  }) {
    this.db = opts.db;
    this.primary = opts.primary;
    this.fallback = opts.fallback;
    this.capsules = opts.capsules;
    this.logger = opts.logger;
    this.preset = opts.preset;
    this.getTurn = opts.getTurn;
    this.verifyArchive = opts.verifyArchive;
  }

  async decide(
    event: ToolEvent,
    ctx: { pressure: number; taskHint?: string },
  ): Promise<DecisionDetail> {
    return (await this.decideAll([event], ctx))[0];
  }

  /**
   * Decide KEEP / CAPSULE / EVICT for a batch of events, returning one
   * DecisionDetail per input event, in input order.
   *
   * Phase 1 evaluates the protection layers (no scoring). Phase 2 scores
   * the remaining events — one batched primary call when the primary
   * supports scoreBatch, otherwise per-item primary with fallback. Phase 3
   * applies the decisions in input order.
   */
  async decideAll(
    events: ToolEvent[],
    ctx: { pressure: number; taskHint?: string },
  ): Promise<DecisionDetail[]> {
    // Phase 1: protection layers (no scoring), in input order.
    const plans: DecisionPlan[] = [];
    for (const event of events) {
      const currentTurn = this.getTurn(event.sessionId);

      const row = this.db.getEventView(event.id, event.sessionId);
      const protection = row && eventProtectionReason(this.db, row, this.preset.minProtectionTurns, event.sessionId, currentTurn);
      if (protection) {
        plans.push({ kind: 'keep', event, currentTurn, reason: protection });
        continue;
      }
      const chain = row && scopedEventChain(this.db, row, event.sessionId);
      const chainSummary = chain ? `chain ${chain.id} (${this.db.getChainEvents(chain.id).length} events)` : undefined;

      // d. Scorable: build the scorer context (up to 8 recent descriptors,
      //    self excluded).
      const recentDescriptors = this.db
        .listEvents(event.sessionId, 8)
        .filter((r) => r.id !== event.id)
        .map((r) => JSON.parse(r.descriptor_json) as ToolDescriptor)
        .slice(0, 8);
      plans.push({
        kind: 'score',
        event,
        currentTurn,
        sctx: {
          recentDescriptors,
          chainSummary,
          pressure: ctx.pressure,
          currentTurn,
          taskHint: ctx.taskHint,
        },
      });
    }

    // Phase 2: score the scorable plans.
    const toScore = plans.filter((p): p is ScorePlan => p.kind === 'score');
    const scored = new Map<DecisionPlan, ScoredInfo>();
    if (toScore.length > 0) {
      if (typeof this.primary.scoreBatch === 'function') {
        try {
          const items: BatchScoreItem[] = toScore.map((p) => ({
            event: p.event,
            ctx: p.sctx,
          }));
          const batchScores = await this.primary.scoreBatch(items);
          if (batchScores.length !== items.length) {
            throw new Error(
              `retention: scoreBatch returned ${batchScores.length} scores for ${items.length} items`,
            );
          }
          batchScores.forEach(assertScore);
          toScore.forEach((p, i) => {
            scored.set(p, {
              score: batchScores[i],
              scorerName: this.primary.name,
              usedFallback: false,
              forceKeep: false,
            });
          });
        } catch (err) {
          // Whole-batch failure: every scorable event goes the fallback route.
          for (const p of toScore) {
            await this.scoreOneViaFallback(p, scored, err);
          }
        }
      } else {
        for (const p of toScore) {
          try {
            const score = await this.primary.score(p.event, p.sctx);
            assertScore(score);
            scored.set(p, {
              score,
              scorerName: this.primary.name,
              usedFallback: false,
              forceKeep: false,
            });
          } catch (err) {
            await this.scoreOneViaFallback(p, scored, err);
          }
        }
      }
    }

    // Phase 3: apply decisions, in input order.
    const details: DecisionDetail[] = [];
    for (const plan of plans) {
      if (plan.kind === 'keep') {
        details.push(
          this.applyKeep(plan.event, plan.currentTurn, plan.reason, undefined),
        );
        continue;
      }
      const info = scored.get(plan);
      if (!info) {
        throw new Error(
          `retention: no score computed for event ${plan.event.id}`,
        );
      }
      if (info.forceKeep) {
        details.push(
          this.applyKeep(
            plan.event,
            plan.currentTurn,
            'fallback-scorer-failed',
            undefined,
          ),
        );
        continue;
      }

      const { score, scorerName, usedFallback } = info;
      this.logger.log('retention scored', {
        eventId: plan.event.id,
        scorer: scorerName,
        score,
        fallback: usedFallback,
      });
      this.db.insertRetentionScore(
        plan.event.id,
        scorerName,
        score,
        plan.currentTurn,
      );

      // Decision floor: side-effect tools and failed events are at least
      // capsuled — never silently evicted. The floor caps how destructive
      // the decision may be (keep < capsule < evict): the final decision is
      // the less destructive of the raw score decision and the floor.
      const mustCapsule =
        plan.event.descriptor.isSideEffect || plan.event.status === 'error';
      let raw: RetentionDecision;
      if (score < this.preset.keepThreshold) raw = 'keep';
      else if (score >= this.preset.evictThreshold) raw = 'evict';
      else raw = 'capsule';
      const floor: RetentionDecision = mustCapsule ? 'capsule' : 'evict';
      let decision: RetentionDecision =
        this.floorOrder[raw] <= this.floorOrder[floor] ? raw : floor;

      let reason =
        `score ${score.toFixed(3)} ` +
        `(keep<${this.preset.keepThreshold}, evict>=${this.preset.evictThreshold})`;
      if (this.floorOrder[raw] > this.floorOrder[floor]) {
        reason += `; floor applied: ${
          plan.event.descriptor.isSideEffect ? 'side-effect' : 'error'
        } tool -> at least capsule`;
      }

      // Fallback cap: a score from the deterministic fallback is never
      // trusted enough to evict outright — cap at capsule.
      const isFallbackScore =
        usedFallback || this.primary.name === 'conservative-fallback';
      if (isFallbackScore && decision === 'evict') {
        decision = 'capsule';
        reason += '; fallback scorer: capped at capsule (never evict)';
      }

      details.push(
        await this.applyDecision(
          plan.event,
          plan.currentTurn,
          decision,
          reason,
          score,
        ),
      );
    }
    return details;
  }

  /**
   * Route one event through the deterministic fallback scorer after the
   * primary failed for it. The fallback never throws in practice; if it
   * somehow does, the event is force-kept instead of blocking the batch.
   */
  private async scoreOneViaFallback(
    p: ScorePlan,
    scored: Map<DecisionPlan, ScoredInfo>,
    error: unknown,
  ): Promise<void> {
    this.logger.log('model fallback', {
      eventId: p.event.id,
      from: this.primary.name,
      error: String(error),
    });
    try {
      const score = await this.fallback.score(p.event, p.sctx);
      assertScore(score);
      scored.set(p, {
        score,
        scorerName: this.fallback.name,
        usedFallback: true,
        forceKeep: false,
      });
    } catch (fallbackError) {
      this.logger.log('model fallback', {
        eventId: p.event.id,
        from: this.fallback.name,
        error: String(fallbackError),
      });
      scored.set(p, {
        score: 0,
        scorerName: this.fallback.name,
        usedFallback: true,
        forceKeep: true,
      });
    }
  }

  /** Recheck mutable protection after any model await, inside the write lock. */
  private freshBlock(event: ToolEvent): string | undefined {
    const row = this.db.getEventView(event.id, event.sessionId);
    if (!row) return 'event-no-longer-available';
    const fresh = rowToToolEvent(row);
    if (fresh.state !== 'hot') return 'concurrent-state-change';
    const protection = eventProtectionReason(this.db, row, this.preset.minProtectionTurns, fresh.sessionId, this.getTurn(fresh.sessionId));
    if (protection) return protection;
    if (fresh.recalledCount !== event.recalledCount) return 'concurrent-recall';
    return undefined;
  }

  private async applyDecision(
    event: ToolEvent,
    turn: number,
    decision: RetentionDecision,
    reason: string,
    score: number,
  ): Promise<DecisionDetail> {
    if (decision !== 'keep') {
      try { await this.verifyArchive?.(event.id); }
      catch { return this.applyKeep(event, turn, 'archive-integrity-failed', score); }
      const blocked = this.freshBlock(event);
      if (blocked) return this.applyKeep(event, turn, blocked, score);
    }
    switch (decision) {
      case 'keep':
        return this.applyKeep(event, turn, reason, score);
      case 'capsule':
        return this.applyCapsule(event, turn, reason, score);
      case 'evict':
        return this.applyEvict(event, turn, reason, score);
    }
  }

  private applyKeep(
    event: ToolEvent,
    turn: number,
    reason: string,
    score: number | undefined,
  ): DecisionDetail {
    this.db.updateEventView(event.id, event.sessionId, { safe_to_evict: score ?? null });
    this.db.insertDecision(event.id, 'keep', reason, score ?? null, turn);
    this.db.bumpStat('decisions_keep');
    this.db.bumpStat('tools_evaluated');
    this.logger.log('decision made', {
      eventId: event.id,
      decision: 'keep',
      reason,
      score,
    });
    return {
      eventId: event.id,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      decision: 'keep',
      reason,
      score,
    };
  }

  private async applyCapsule(
    event: ToolEvent,
    turn: number,
    reason: string,
    score: number,
  ): Promise<DecisionDetail> {
    let capsuleId: string;
    try {
      const capsule = await this.capsules.build(event);
      capsuleId = capsule.id;
      // No awaits between this recheck and the synchronous commit.
      const blocked = this.freshBlock(event);
      if (blocked) return this.applyKeep(event, turn, blocked, score);
      const committed = this.db.transaction(() => {
        if (this.freshBlock(event)) return false;
        this.db.updateEventView(event.id, event.sessionId, {
        state: 'capsule',
        capsule_id: capsuleId,
        safe_to_evict: score,
        });
        return true;
      });
      if (!committed) return this.applyKeep(event, turn, 'concurrent-protection', score);
      this.db.insertDecision(event.id, 'capsule', reason, score, turn);
      this.db.bumpStat('decisions_capsule');
      const saved = Math.max(
        0,
        event.descriptor.tokenEstimate - Math.ceil(capsule.summary.length / 4),
      );
      this.db.bumpStat('tokens_saved_estimate', saved);
      this.db.bumpStat('tools_evaluated');
      this.logger.log('capsule generated', {
        eventId: event.id,
        capsuleId,
        savedTokens: saved,
      });
      this.logger.log('decision made', {
        eventId: event.id,
        decision: 'capsule',
        reason,
        score,
      });
      return {
        eventId: event.id,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        decision: 'capsule',
        reason,
        score,
      };
    } catch (e) {
      // Capsule build failed: fall back to KEEP (never compact unarchived /
      // un-summarized content under pressure).
      this.logger.log('capsule failed', {
        eventId: event.id,
        error: String(e),
      });
      return this.applyKeep(event, turn, 'capsule-failed', score);
    }
  }

  private applyEvict(
    event: ToolEvent,
    turn: number,
    reason: string,
    score: number,
  ): DecisionDetail {
    const committed = this.db.transaction(() => {
      if (this.freshBlock(event)) return false;
      this.db.updateEventView(event.id, event.sessionId, {state: 'evicted', safe_to_evict: score});
      return true;
    });
    if (!committed) return this.applyKeep(event, turn, 'concurrent-protection', score);
    this.db.insertDecision(event.id, 'evict', reason, score, turn);
    this.db.bumpStat('decisions_evict');
    this.db.bumpStat('tokens_saved_estimate', event.descriptor.tokenEstimate);
    this.db.bumpStat('tools_evaluated');
    this.logger.log('evicted', {
      eventId: event.id,
      toolCallId: event.toolCallId,
      reason,
      score,
    });
    this.logger.log('decision made', {
      eventId: event.id,
      decision: 'evict',
      reason,
      score,
    });
    return {
      eventId: event.id,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      decision: 'evict',
      reason,
      score,
    };
  }
}

function assertScore(score: unknown): asserts score is number {
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) {
    throw new Error('Retention scores must be finite numbers in [0, 1]');
  }
}
