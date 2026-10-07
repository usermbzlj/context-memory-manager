/**
 * Rule-based chain linker (PRD §12): groups related tool events into
 * chains — edit→test cycles, failure→fix sequences, path-overlapping
 * work — with a cheap-model assist for fuzzy boundaries when the rules
 * find nothing (PRD §16.1: rules first + cheap-model assist).
 *
 * Only original events from the chain's agent/workspace/session may join.
 * Recalled views remain retrieval context and never mutate the source chain.
 */

import { randomUUID } from 'node:crypto';
import type {
  CapsuleBuilder,
  ChainLinker,
  ChainLinkResult,
  Logger,
  ModelProvider,
  ProviderCallRecord,
  ToolEvent,
} from '../types.js';
import type { Database } from '../storage/sqlite.js';
import { rowToChain, rowToToolEvent } from '../types.js';
import { completeWithFailover } from '../providers/failover.js';
import { parseJsonLenient } from '../scoring/jev.js';

const FAILED_VERDICT_RE = /[1-9]\d*\s+failed/;
const PASSING_VERDICT_RE = /0\s+failed/;

const CHAIN_ASSIST_SYSTEM_PROMPT =
  'You are linking tool events into logical work chains for a coding agent. ' +
  'Given two tool event descriptors, decide whether they belong to the same ' +
  'logical work chain (e.g. investigate → fix → verify). Reply with ONLY JSON: ' +
  '{"linked": true/false}.';

export class RuleChainLinker implements ChainLinker {
  private readonly lookback: number;

  constructor(
    private readonly opts: {
      db: Database;
      capsules: CapsuleBuilder;
      logger: Logger;
      lookback?: number;
      /** Optional cheap-model providers for fuzzy boundary assist. */
      chainProviders?: ModelProvider[];
      recordCall?: (r: ProviderCallRecord) => void;
    },
  ) {
    this.lookback = opts.lookback ?? 20;
  }

  private isTestCommand(input: string): boolean {
    return /\b(npm|yarn|pnpm|bun)\s+(test|run\s+test)|(^|\s)(pytest|jest|vitest)(\s|$)|go\s+test|make\s+test|\bctest\b/i.test(
      input,
    );
  }

  /** The active chain an event belongs to, if any (completed chains excluded). */
  private activeChainOf(event: ToolEvent) {
    if (!event.chainId) return undefined;
    const chain = this.opts.db.getChain(event.chainId);
    return chain && chain.status === 'active' && chain.agent === event.agent &&
      chain.workspace_id === event.workspaceId && chain.session_id === event.sessionId ? chain : undefined;
  }

  private isSourceEvent(event: ToolEvent): boolean {
    const source = this.opts.db.getToolEvent(event.id);
    return Boolean(source && source.agent === event.agent && source.workspace_id === event.workspaceId &&
      source.session_id === event.sessionId);
  }

  private pathsOverlap(a: string[], b: string[]): boolean {
    const set = new Set(a);
    return b.some((p) => set.has(p));
  }

  /** First two '/'-separated segments of a path, for fuzzy directory overlap. */
  private pathPrefix(p: string): string {
    return p
      .split('/')
      .filter((s) => s.length > 0)
      .slice(0, 2)
      .join('/');
  }

  private partialPathOverlap(a: string[], b: string[]): boolean {
    const prefixes = new Set(
      a.map((p) => this.pathPrefix(p)).filter((s) => s.length > 0),
    );
    if (prefixes.size === 0) return false;
    return b.some((p) => {
      const s = this.pathPrefix(p);
      return s.length > 0 && prefixes.has(s);
    });
  }

  /**
   * Weak signal for the cheap-model assist: the event shares a directory
   * prefix with a recent event, or follows a recent failure on different
   * files. Returns the candidate recent event, or null when there is no
   * signal. Only consulted when all three rules returned null.
   */
  private weakSignalCandidate(
    event: ToolEvent,
    recent: ToolEvent[],
  ): ToolEvent | null {
    for (const e of recent) {
      if (this.partialPathOverlap(event.descriptor.paths, e.descriptor.paths)) {
        return e;
      }
    }
    for (const e of recent) {
      const isFailure =
        e.status === 'error' ||
        (e.descriptor.testVerdict !== undefined &&
          FAILED_VERDICT_RE.test(e.descriptor.testVerdict));
      if (
        isFailure &&
        event.turn - e.turn <= 12 &&
        !this.pathsOverlap(event.descriptor.paths, e.descriptor.paths)
      ) {
        return e;
      }
    }
    return null;
  }

  private descriptorish(event: ToolEvent): Record<string, unknown> {
    const d = event.descriptor;
    return {
      tool: d.tool,
      inputSummary: d.inputSummary,
      salient: d.salient.slice(0, 6),
      paths: d.paths.slice(0, 6),
      testVerdict: d.testVerdict,
      outcome: d.outcome,
      status: event.status,
    };
  }

  /**
   * Cheap-model assist for fuzzy chain boundaries (PRD §16.1: rules first +
   * cheap-model assist). Makes at most one model call. Never throws for
   * model reasons — any model error, invalid JSON, or non-boolean verdict
   * returns null (logged) and the event stays unlinked.
   */
  private async modelAssist(
    event: ToolEvent,
    candidate: ToolEvent,
  ): Promise<ChainLinkResult | null> {
    const providers = this.opts.chainProviders;
    const recordCall = this.opts.recordCall;
    if (!providers || providers.length === 0 || !recordCall) {
      return null;
    }
    try {
      const res = await completeWithFailover(
        providers,
        {
          system: CHAIN_ASSIST_SYSTEM_PROMPT,
          user: JSON.stringify({
            a: this.descriptorish(event),
            b: this.descriptorish(candidate),
          }),
          jsonMode: true,
          maxTokens: 64,
          timeoutMs: 15000,
        },
        { purpose: 'chain', recordCall, logger: this.opts.logger, validate: r => {
          const parsed=parseJsonLenient(r.text) as {linked?:unknown}|null;
          if(!parsed || typeof parsed.linked!=='boolean')throw new Error('Invalid chain decision');
        } },
      );
      const parsed = parseJsonLenient(res.text) as { linked?: unknown } | null;
      if (!parsed || typeof parsed.linked !== 'boolean') {
        this.opts.logger.log('chain model assist failed', {
          eventId: event.id,
          candidateId: candidate.id,
          error: 'model returned non-boolean linked verdict',
        });
        return null;
      }
      if (!parsed.linked) {
        return null;
      }
      const chain = this.activeChainOf(candidate);
      return chain ? this.joinChain(chain.id, event) : this.createChain(event, candidate);
    } catch (e) {
      this.opts.logger.log('chain model assist failed', {
        eventId: event.id,
        candidateId: candidate.id,
        error: String(e),
      });
      return null;
    }
  }

  private recentEvents(event: ToolEvent): ToolEvent[] {
    // listEvents returns turn DESC (most recent first); sort defensively.
    return this.opts.db
      .listEvents(event.sessionId, this.lookback)
      .map(rowToToolEvent)
      .filter((e) => e.id !== event.id && e.turn < event.turn && e.agent === event.agent &&
        e.workspaceId === event.workspaceId && e.sessionId === event.sessionId && this.isSourceEvent(e))
      .sort((a, b) => b.turn - a.turn);
  }

  private createChain(event: ToolEvent, seed?: ToolEvent): ChainLinkResult {
    const now = Date.now();
    const id = randomUUID();
    return this.opts.db.transaction(() => {
      if (!this.isSourceEvent(event)) throw new Error('Recalled views cannot become source chain members');
      this.opts.db.insertChain({
        id,
        agent: event.agent,
        workspace_id: event.workspaceId,
        session_id: event.sessionId,
        status: 'active',
        capsule_id: null,
        created_at: now,
        updated_at: now,
      });
      const includeSeed = seed && !seed.chainId && seed.agent === event.agent && seed.workspaceId === event.workspaceId &&
        seed.sessionId === event.sessionId && this.isSourceEvent(seed);
      if (includeSeed) {
        this.opts.db.addChainMember(id, seed.id, 0);
        this.opts.db.updateToolEvent(seed.id, {chain_id: id});
      }
      this.opts.db.addChainMember(id, event.id, includeSeed ? 1 : 0);
      this.opts.db.updateToolEvent(event.id, {chain_id: id});
      return { chainId: id, created: true };
    });
  }

  private joinChain(chainId: string, event: ToolEvent): ChainLinkResult | null {
    return this.opts.db.transaction(() => {
      const chain = this.opts.db.getChain(chainId);
      if (!chain || chain.status !== 'active' || chain.agent !== event.agent || chain.workspace_id !== event.workspaceId ||
        chain.session_id !== event.sessionId || !this.isSourceEvent(event)) return null;
      const members = this.opts.db.getChainMembers(chainId);
      if (!members.some(m => m === event.id)) this.opts.db.addChainMember(chainId, event.id, members.length);
      this.opts.db.updateToolEvent(event.id, {chain_id: chainId});
      this.opts.db.updateChain(chainId, {updated_at: Date.now()});
      return { chainId, created: false };
    });
  }

  async linkEvent(event: ToolEvent): Promise<ChainLinkResult | null> {
    if (!this.isSourceEvent(event)) return null;
    const recent = this.recentEvents(event);

    // Rule 1: path overlap with a recent event's active chain.
    for (const e of recent) {
      const chain = this.activeChainOf(e);
      if (
        chain &&
        this.pathsOverlap(event.descriptor.paths, e.descriptor.paths)
      ) {
        return this.joinChain(chain.id, event);
      }
    }

    // Rule 2: test command following a recent side-effect event (<=6 turns).
    if (this.isTestCommand(event.descriptor.inputSummary)) {
      const recentEdit = recent.find(
        (e) => e.descriptor.isSideEffect && event.turn - e.turn <= 6,
      );
      if (recentEdit) {
        const chain = this.activeChainOf(recentEdit);
        return chain ? this.joinChain(chain.id, event) : this.createChain(event, recentEdit);
      }
    }

    // Rule 3: failure -> fix — a recent error or failing test verdict.
    const recentFailure = recent.find(
      (e) =>
        event.turn - e.turn <= 12 &&
        (e.status === 'error' ||
          (e.descriptor.testVerdict !== undefined &&
            FAILED_VERDICT_RE.test(e.descriptor.testVerdict))),
    );
    if (recentFailure) {
      const chain = this.activeChainOf(recentFailure);
      return chain ? this.joinChain(chain.id, event) : this.createChain(event, recentFailure);
    }

    // Cheap-model assist for fuzzy boundaries (PRD §16.1): only when the
    // rules found nothing and a weak signal suggests a possible link.
    const weakCandidate = this.weakSignalCandidate(event, recent);
    if (weakCandidate) {
      return this.modelAssist(event, weakCandidate);
    }

    return null;
  }

  async refreshChainCapsule(chainId: string): Promise<void> {
    const db = this.opts.db;
    const chain = db.getChain(chainId);
    if (!chain) return;
    const events = db.getChainEvents(chainId).map(rowToToolEvent);
    if (events.length === 0) return;
    await this.opts.capsules.buildChainCapsule(
      rowToChain(
        chain,
        events.map((e) => e.id),
      ),
      events,
    );
  }

  async maybeCompleteChain(
    chainId: string,
    event: ToolEvent,
  ): Promise<boolean> {
    const db = this.opts.db;
    const chain = db.getChain(chainId);
    if (!chain || chain.status !== 'active' || chain.agent !== event.agent || chain.workspace_id !== event.workspaceId ||
      chain.session_id !== event.sessionId || !this.isSourceEvent(event)) return false;

    const events = db.getChainEvents(chainId).map(rowToToolEvent);
    if (!events.some(member => member.id === event.id)) return false;
    const hadFailure = events.some(
      (e) =>
        e.status === 'error' ||
        (e.descriptor.testVerdict !== undefined &&
          FAILED_VERDICT_RE.test(e.descriptor.testVerdict)),
    );
    const nowPassing =
      event.descriptor.testVerdict !== undefined &&
      PASSING_VERDICT_RE.test(event.descriptor.testVerdict);
    const currentTurn = db.getCurrentTurn(event.sessionId);
    const maxMemberTurn = Math.max(...events.map((e) => e.turn));

    const complete =
      (hadFailure && nowPassing) || currentTurn - maxMemberTurn > 25;
    if (!complete) return false;

    db.updateChain(chainId, { status: 'completed' });
    await this.opts.capsules.freezeChainCapsule(chainId);
    this.opts.logger.log('chain completed', { chainId });
    return true;
  }
}
