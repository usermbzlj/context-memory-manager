/**
 * Jev-shaped default retention scorer (PRD §10).
 *
 * Model-backed: asks a provider how safe it is to evict the event's full
 * content from the working context (the original stays archived and can be
 * recalled). Provider failures throw so the caller can fall back to the
 * deterministic ConservativeFallbackScorer — Jev itself never guesses when
 * the model is unreachable.
 */

import type {
  BatchScoreItem,
  Logger,
  ModelProvider,
  ProviderCallRecord,
  RetentionScorer,
  ScorerContext,
  ToolEvent,
} from '../types.js';
import { completeWithFailover } from '../providers/failover.js';

const SYSTEM_PROMPT =
  "You are Jev, a retention scorer for a coding agent's tool context manager. " +
  'Given a tool interaction summary, judge how safe it is to remove its full ' +
  'content from the working context (the original stays archived and can be ' +
  'recalled). Reply with ONLY JSON: {"safeToEvict": <0..1>}. ' +
  '0 = must keep visible, 1 = safe to remove.';

const BATCH_SYSTEM_PROMPT =
  'you are Jev, judge per-event safeToEvict 0..1 for each event in the input array; ' +
  'reply with ONLY JSON {"scores":[...]} in the same order as the input events.';

/** Parse a JSON object, tolerating markdown code fences around it. */
export function parseJsonLenient(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return JSON.parse(fenced ? fenced[1] : text);
}

/** Pull a score array out of a leniently-parsed batch payload. */
function asScoreArray(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed !== null && typeof parsed === 'object') {
    const scores = (parsed as { scores?: unknown }).scores;
    if (Array.isArray(scores)) return scores;
  }
  throw new Error(
    'jev: invalid batch response (expected {"scores":[...]} or a bare JSON array)',
  );
}

/**
 * Validate a batch model response: an array of exactly `expectedLength`
 * scores, each a finite number — either a raw number or
 * `{safeToEvict: number}`.
 */
function parseBatchScores(parsed: unknown, expectedLength: number): number[] {
  const list = asScoreArray(parsed);
  if (list.length !== expectedLength) {
    throw new Error(
      `jev: invalid batch response (expected ${expectedLength} scores, got ${list.length})`,
    );
  }
  return list.map((entry, i) => {
    const raw =
      entry !== null && typeof entry === 'object' && 'safeToEvict' in entry
        ? (entry as { safeToEvict: unknown }).safeToEvict
        : entry;
    const n = raw;
    if (typeof n !== 'number' || !Number.isFinite(n) || n<0 || n>1) {
      throw new Error(
        `jev: invalid batch response (score at index ${i} is not a finite number)`,
      );
    }
    return n as number;
  });
}

function parseSingle(text:string):number {
  const parsed=parseJsonLenient(text);
  if(!parsed || typeof parsed!=='object' || Array.isArray(parsed))throw new Error('jev: expected an object');
  const safe=(parsed as {safeToEvict?:unknown}).safeToEvict;
  if(typeof safe!=='number' || !Number.isFinite(safe) || safe<0 || safe>1)throw new Error('jev: score must be a number in [0,1]');
  return safe;
}

export class JevScorer implements RetentionScorer {
  readonly name = 'jev';

  constructor(
    private readonly opts: {
      providers: ModelProvider[];
      recordCall: (r: ProviderCallRecord) => void;
      logger: Logger;
    },
  ) {}

  async score(event: ToolEvent, ctx: ScorerContext): Promise<number> {
    if (this.opts.providers.length === 0) {
      throw new Error('jev: no providers configured');
    }
    const d = event.descriptor;
    const user = JSON.stringify({
      tool: d.tool,
      status: d.status,
      inputSummary: d.inputSummary,
      salient: d.salient.slice(0, 8),
      paths: d.paths.slice(0, 8),
      testVerdict: d.testVerdict,
      outcome: d.outcome,
      isSideEffect: d.isSideEffect,
      ageTurns: ctx.currentTurn - event.turn,
      chainSummary: ctx.chainSummary,
      pressure: ctx.pressure,
    });

    const res = await completeWithFailover(
      this.opts.providers,
      { system: SYSTEM_PROMPT, user, jsonMode: true, maxTokens: 64, timeoutMs: 20000 },
      {
        purpose: 'retention',
        recordCall: this.opts.recordCall,
        logger: this.opts.logger,
        validate: r => {parseSingle(r.text);},
      },
    );

    return parseSingle(res.text);
  }

  /**
   * Batched scoring: ONE model call for up to 8 events (extra items are
   * sliced off; the engine only ever passes ≤8).
   *
   * Whole-batch failure — provider error or an invalid response — throws so
   * the caller can route every item to the fallback scorer. Nothing is
   * caught here.
   */
  async scoreBatch(items: BatchScoreItem[]): Promise<number[]> {
    if (items.length === 0) return [];
    if (this.opts.providers.length === 0) {
      throw new Error('jev: no providers configured');
    }
    const batch = items.slice(0, 8);
    const user = JSON.stringify({
      events: batch.map(({ event, ctx }) => {
        const d = event.descriptor;
        return {
          tool: d.tool,
          status: d.status,
          inputSummary: d.inputSummary,
          salient: d.salient.slice(0, 8),
          paths: d.paths.slice(0, 8),
          testVerdict: d.testVerdict,
          outcome: d.outcome,
          isSideEffect: d.isSideEffect,
          ageTurns: ctx.currentTurn - event.turn,
          chainSummary: ctx.chainSummary,
          pressure: ctx.pressure,
        };
      }),
    });

    const res = await completeWithFailover(
      this.opts.providers,
      {
        system: BATCH_SYSTEM_PROMPT,
        user,
        jsonMode: true,
        maxTokens: 256,
        timeoutMs: 30000,
      },
      {
        purpose: 'retention',
        recordCall: this.opts.recordCall,
        logger: this.opts.logger,
        validate: r => {parseBatchScores(parseJsonLenient(r.text),batch.length);},
      },
    );

    return parseBatchScores(parseJsonLenient(res.text), batch.length);
  }
}
