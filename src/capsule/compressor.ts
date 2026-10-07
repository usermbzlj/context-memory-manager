/**
 * Capsule building: deterministic draft extraction + cheap-model refine,
 * with validation that keeps capsules honest (PRD §11).
 *
 * Invariants:
 *  - A capsule is never a source of truth. Anchors are validated against
 *    the deterministic draft: anything the model invents is dropped and
 *    logged, never persisted.
 *  - A frozen capsule is immutable: buildChainCapsule returns it unchanged
 *    and refreshChainCapsule must not rewrite it.
 */

import { randomUUID } from 'node:crypto';
import type {
  CapsuleBuilder,
  CapsuleDraft,
  CheapModel,
  Logger,
  MemoryCapsule,
  ModelProvider,
  ProviderCallRecord,
  ToolChain,
  ToolEvent,
} from '../types.js';
import { CapsuleError, rowToCapsule } from '../types.js';
import type { Database } from '../storage/sqlite.js';
import { extractCapsuleDraft } from './extractor.js';
import { completeWithFailover } from '../providers/failover.js';
import { parseJsonLenient } from '../scoring/jev.js';
import { truncateText } from '../util/text.js';

/** Deterministic cheap model: compresses without inventing content. */
export class DeterministicCheapModel implements CheapModel {
  readonly name = 'deterministic-cheap';

  async refine(draft: CapsuleDraft, _event: ToolEvent): Promise<CapsuleDraft> {
    return {
      summary: truncateText(draft.summary, 280),
      facts: [...new Set(draft.facts.map((f) => truncateText(f, 200)))].slice(0, 12),
      anchors: [...new Set(draft.anchors)].slice(0, 12),
      ...(draft.outcome !== undefined ? { outcome: draft.outcome } : {}),
    };
  }
}

const CAPSULE_REFINER_SYSTEM_PROMPT =
  "You are a capsule refiner for a coding agent's tool context manager. " +
  'Rewrite the deterministic draft into a denser capsule. Rules: ONLY reuse ' +
  'anchors (paths/ids/symbols) already present in the draft — never invent new ' +
  'ones; keep every fact grounded in the draft; reply with ONLY JSON: ' +
  '{"summary": string, "facts": string[], "anchors": string[], "outcome"?: string}.';

/**
 * Cheap model backed by a real provider via failover.
 *
 * With no providers configured it delegates to the deterministic stub, so
 * behaviour is identical to DeterministicCheapModel in that case.
 *
 * The model only refines the draft: ids/hashes are attached and anchors are
 * validated against the draft later by CapsuleBuilderImpl.build().
 */
export class ModelBackedCheapModel implements CheapModel {
  readonly name = 'model-cheap';

  constructor(
    private readonly opts: {
      providers: ModelProvider[];
      recordCall: (r: ProviderCallRecord) => void;
      logger: Logger;
    },
  ) {}

  async refine(draft: CapsuleDraft, event: ToolEvent): Promise<CapsuleDraft> {
    if (this.opts.providers.length === 0) {
      return new DeterministicCheapModel().refine(draft, event);
    }

    const res = await completeWithFailover(
      this.opts.providers,
      {
        system: CAPSULE_REFINER_SYSTEM_PROMPT,
        user: JSON.stringify({
          draft,
          tool: event.descriptor.tool,
          status: event.descriptor.status,
          outcome: event.descriptor.outcome,
        }),
        jsonMode: true,
        maxTokens: 512,
        timeoutMs: 30000,
      },
      {
        purpose: 'capsule',
        recordCall: this.opts.recordCall,
        logger: this.opts.logger,
        validate: r => {validateCapsuleJson(parseJsonLenient(r.text));},
      },
    );

    return validateCapsuleJson(parseJsonLenient(res.text));
  }
}

/** Strict shape validation for the model's capsule JSON. */
function validateCapsuleJson(parsed: unknown): CapsuleDraft {
  function invalid(): never {
    throw new CapsuleError('cheap model returned invalid capsule JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    invalid();
  }
  const obj = parsed as Record<string, unknown>;

  const summary = obj.summary;
  if (typeof summary !== 'string' || summary.trim().length === 0) {
    invalid();
  }
  const factsRaw = obj.facts;
  const anchorsRaw = obj.anchors;
  if (!Array.isArray(factsRaw) || !Array.isArray(anchorsRaw)) {
    invalid();
  }
  // Coerce non-strings out of the arrays; cap each at 12.
  const facts = factsRaw
    .filter((f): f is string => typeof f === 'string')
    .slice(0, 12);
  const anchors = anchorsRaw
    .filter((a): a is string => typeof a === 'string')
    .slice(0, 12);

  const outcome = obj.outcome;
  if (outcome !== undefined && typeof outcome !== 'string') {
    invalid();
  }

  return {
    summary,
    facts,
    anchors,
    ...(outcome !== undefined ? { outcome } : {}),
  };
}

function capsuleRowFromCapsule(c: MemoryCapsule) {
  return {
    id: c.id,
    source_event_ids_json: JSON.stringify(c.sourceEventIds),
    summary: c.summary,
    facts_json: JSON.stringify(c.facts),
    anchors_json: JSON.stringify(c.anchors),
    outcome: c.outcome ?? null,
    frozen: c.frozen ? 1 : 0,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
  };
}

export class CapsuleBuilderImpl implements CapsuleBuilder {
  private failNext = false;

  constructor(
    private readonly opts: {
      db: Database;
      cheapModel: CheapModel;
      logger: Logger;
    },
  ) {}

  /** Test hook: the next build()/buildChainCapsule() throws. */
  failNextBuild(): void {
    this.failNext = true;
  }

  private takeFailNext(): void {
    if (this.failNext) {
      this.failNext = false;
      throw new CapsuleError('injected capsule failure');
    }
  }

  async build(event: ToolEvent): Promise<MemoryCapsule> {
    this.takeFailNext();
    const draft = extractCapsuleDraft(event);

    let refined: CapsuleDraft;
    try {
      refined = await this.opts.cheapModel.refine(draft, event);
    } catch (e) {
      throw new CapsuleError('cheap model refine failed', { cause: e });
    }

    if (!refined.summary.trim()) {
      throw new CapsuleError('empty summary');
    }

    // Validation: the model may only reuse anchors from the draft.
    const allowedAnchors = new Set(draft.anchors);
    const dropped = refined.anchors.filter((a) => !allowedAnchors.has(a));
    if (dropped.length > 0) {
      this.opts.logger.log('capsule validation', {
        eventId: event.id,
        dropped,
      });
    }
    const anchors = refined.anchors.filter((a) => allowedAnchors.has(a));

    if (refined.facts.length === 0 && !refined.summary) {
      throw new CapsuleError('empty capsule');
    }

    const now = Date.now();
    const capsule: MemoryCapsule = {
      id: randomUUID(),
      sourceEventIds: [event.id],
      summary: draft.summary,
      facts: [...new Set([...refined.facts.filter(f => draft.facts.includes(f)), ...draft.facts])].slice(0, 12),
      anchors,
      ...(draft.outcome !== undefined ? { outcome: draft.outcome } : {}),
      frozen: false,
      createdAt: now,
      updatedAt: now,
    };
    this.opts.db.insertCapsule(capsuleRowFromCapsule(capsule));
    return capsule;
  }

  async buildChainCapsule(
    chain: ToolChain,
    events: ToolEvent[],
  ): Promise<MemoryCapsule> {
    this.takeFailNext();
    const db = this.opts.db;
    if (events.length === 0) {
      throw new CapsuleError('buildChainCapsule: no events');
    }

    // Frozen capsules are immutable: return unchanged.
    if (chain.capsuleId) {
      const existing = db.getCapsule(chain.capsuleId);
      if (existing && existing.frozen === 1) {
        return rowToCapsule(existing);
      }
    }

    // Important sub-events: first error, side-effect events (<=3), last.
    const important: ToolEvent[] = [];
    const pushUnique = (e: ToolEvent | undefined) => {
      if (e && !important.includes(e)) important.push(e);
    };
    pushUnique(events.find((e) => e.status === 'error'));
    for (const e of events) {
      if (important.length >= 5) break;
      if (e.descriptor.isSideEffect) pushUnique(e);
    }
    pushUnique(events[events.length - 1]);

    const first = events[0];
    const last = events[events.length - 1];
    const lastOutcome = last.descriptor.outcome
      ? ` → ${last.descriptor.outcome}`
      : '';
    const summary = `Chain of ${events.length} tool events: ${first.descriptor.inputSummary} … → ${last.descriptor.inputSummary}${lastOutcome}`;

    const facts = important
      .map(
        (e) =>
          `• ${e.descriptor.inputSummary}${e.descriptor.outcome ? ` → ${e.descriptor.outcome}` : ''}`,
      )
      .slice(0, 10);

    const anchors = [
      ...new Set(events.flatMap((e) => e.descriptor.paths)),
    ].slice(0, 16);

    const outcome = last.descriptor.outcome;
    const now = Date.now();

    if (chain.capsuleId) {
      const existing = db.getCapsule(chain.capsuleId);
      if (existing && existing.frozen !== 1) {
        db.updateCapsule(chain.capsuleId, {
        source_event_ids_json: JSON.stringify(events.map(e => e.id)),
          summary,
          facts_json: JSON.stringify(facts),
          anchors_json: JSON.stringify(anchors),
          outcome: outcome ?? null,
          updated_at: now,
        });
        db.updateChain(chain.id, { capsule_id: chain.capsuleId });
        return {
          id: chain.capsuleId,
          sourceEventIds: events.map(e => e.id),
          summary,
          facts,
          anchors,
          ...(outcome !== undefined ? { outcome } : {}),
          frozen: false,
          createdAt: existing.created_at,
          updatedAt: now,
        };
      }
    }

    const capsule: MemoryCapsule = {
      id: randomUUID(),
      sourceEventIds: events.map((e) => e.id),
      summary,
      facts,
      anchors,
      ...(outcome !== undefined ? { outcome } : {}),
      frozen: false,
      createdAt: now,
      updatedAt: now,
    };
    db.insertCapsule(capsuleRowFromCapsule(capsule));
    db.updateChain(chain.id, { capsule_id: capsule.id });
    return capsule;
  }

  async freezeChainCapsule(chainId: string): Promise<void> {
    const chain = this.opts.db.getChain(chainId);
    if (chain?.capsule_id) {
      this.opts.db.updateCapsule(chain.capsule_id, { frozen: 1 });
    }
  }
}
