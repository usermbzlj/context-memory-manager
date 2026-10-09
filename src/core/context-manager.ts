import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  Config,
  ContentRef,
  DecisionDetail,
  GcResult,
  Logger,
  ModelProvider,
  ProviderConfig,
  ProviderCallRecord,
  RecallResult,
  RecordResult,
  RetentionScorer,
  StatsSnapshot,
  TidyResult,
  ToolDescriptor,
  ToolEvent,
  ToolEventInput,
  ToolEventRow,
  ToolState,
} from '../types.js';
import { RecallError, rowToCapsule, rowToToolEvent } from '../types.js';
import {
  activePreset,
  loadConfig,
  createConfigIfAbsent,
  configRevision,
} from '../config.js';
import { createLogger } from '../logging.js';
import { Database } from '../storage/sqlite.js';
import { BlobStore } from '../storage/blob-store.js';
import { ArchiveServiceImpl, resolveWorkspaceId, validateToolInput } from '../storage/archive.js';
import {
  buildDescriptor,
  estimateTokens,
  isInternalTool,
} from '../descriptor.js';
import { ConservativeFallbackScorer } from '../scoring/fallback.js';
import { JevScorer } from '../scoring/jev.js';
import { SystemOneScorer } from '../scoring/systemone.js';
import {
  CapsuleBuilderImpl,
  ModelBackedCheapModel,
} from '../capsule/compressor.js';
import { RuleChainLinker } from '../chains/linker.js';
import { buildProviders } from '../providers/index.js';
import { observeProvider } from '../providers/failover.js';
import { createRuntimeObserver, type RuntimeKind, type RuntimeObserver, type ObserverOptions } from '../observability/runtime.js';
import { PressureMonitor } from './pressure.js';
import { RetentionEngine } from './retention.js';
import { eventProtectionReason } from './protection.js';
import { errorMessage, integer } from '../util/validation.js';

/** Fallback window size when the host has not reported usage. */
const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Max HOT events scored per tidy pass (bounds scorer cost, PRD §40). */
const TIDY_BATCH_LIMIT = 8;

/** Max tidy passes per maybeTidy call (loop-to-release guard). */
const MAX_TIDY_PASSES = 3;

// Fixed core event names -> the observed operation kind that degraded. Only the name is read, never its fields.
const fallbackEvents: Record<string,RuntimeKind> = {
  'model fallback':'score','capsule failed':'score','chain model assist failed':'chain','capsule validation':'capsule',
};
function observeFallbackLogger(base: Logger, observer: RuntimeObserver): Logger {
  return {
    log(event,fields) {const kind=fallbackEvents[event];if(kind)observer.noteFallback(kind);base.log(event,fields);},
    child(fields) {return observeFallbackLogger(base.child(fields),observer);},
    close() {base.close();},
  };
}

class ObservedCapsuleBuilder extends CapsuleBuilderImpl {
  constructor(opts: ConstructorParameters<typeof CapsuleBuilderImpl>[0], private readonly observer: RuntimeObserver) { super(opts); }
  override async build(event: ToolEvent) {
    return this.observer.withScope({agent:event.agent,workspaceId:event.workspaceId},async () => {
      const end=this.observer.operation({kind:'capsule',eventId:event.id,role:'capsule'});
      try {const result=await super.build(event);end();return result;} catch (error) {end({status:'error'});throw error;}
    });
  }
  override async buildChainCapsule(...args: Parameters<CapsuleBuilderImpl['buildChainCapsule']>) {
    const chain=args[0];
    return this.observer.withScope({agent:chain.agent,workspaceId:chain.workspaceId},async () => {
      const end=this.observer.operation({kind:'capsule',role:'capsule'});
      try {const result=await super.buildChainCapsule(...args);end();return result;} catch (error) {end({status:'error'});throw error;}
    });
  }
}
class ObservedRetentionEngine extends RetentionEngine {
  constructor(opts: ConstructorParameters<typeof RetentionEngine>[0], private readonly observer: RuntimeObserver) { super(opts); }
  override async decideAll(...args: Parameters<RetentionEngine['decideAll']>) {
    const first=args[0][0];
    if (!first) return super.decideAll(...args);
    return this.observer.withScope({agent:first.agent,workspaceId:first.workspaceId},async () => {
      const end=this.observer.operation({kind:'score',role:'retention'});
      try {
        const result=await super.decideAll(...args);
        end();
        return result;
      } catch (error) {end({status:'error'});throw error;}
    });
  }
}

interface ConstructorOpts {
  config: Config;
  db: Database;
  logger: Logger;
  archive: ArchiveServiceImpl;
  capsules: CapsuleBuilderImpl;
  retention: RetentionEngine;
  linker: RuleChainLinker;
  pressure: PressureMonitor;
  runtime?: RuntimeObserver;
}

/**
 * ContextManager: the Phase 1 Core orchestration facade.
 *
 * Lifecycle (PRD): tool completes -> archive immediately -> descriptor ->
 * chain linking -> stays HOT -> on context pressure: retention scoring ->
 * KEEP / CAPSULE / EVICT. Invariants are enforced by the sub-engines:
 * archive failure => KEEP (never compact unarchived); capsule never source
 * of truth; recall => HOT + protection; side-effect tools at least capsule;
 * internal manager tools excluded from the management chain (audit only).
 */
export class ContextManager {
  readonly config: Config;
  readonly db: Database;
  readonly logger: Logger;
  readonly archive: ArchiveServiceImpl;
  readonly capsules: CapsuleBuilderImpl;
  readonly retention: RetentionEngine;
  readonly linker: RuleChainLinker;
  readonly runtime: RuntimeObserver;

  private readonly pressure: PressureMonitor;
  private readonly lastTidy: Map<string, { turn: number; used: number }> =
    new Map();

  constructor(opts: ConstructorOpts) {
    this.config = opts.config;
    this.db = opts.db;
    this.logger = opts.logger;
    this.archive = opts.archive;
    this.capsules = opts.capsules;
    this.retention = opts.retention;
    this.linker = opts.linker;
    this.pressure = opts.pressure;
    this.runtime = opts.runtime ?? createRuntimeObserver(opts.config.storage.path);
  }

  /**
   * Open a manager over a storage root. Creates the root and writes back
   * config.json when the file is missing; otherwise disk config wins and
   * explicit overrides win over everything (see config.ts).
   */
  static open(
    storagePath?: string,
    overrides?: Record<string, unknown>,
    runtimeOptions?: ObserverOptions,
  ): ContextManager {
    let cfg = loadConfig(storagePath, overrides);
    fs.mkdirSync(cfg.storage.path, { recursive: true, mode: 0o700 });
    const configFile = path.join(cfg.storage.path, 'config.json');
    if (!fs.existsSync(configFile)) {
      if (!createConfigIfAbsent(cfg)) cfg = loadConfig(storagePath, overrides);
    }

    let adoptedRevision: string | undefined;
    // Revision describes the exact file loaded, not a later concurrent save.
    for (let attempt=0;attempt<3;attempt++) {
      const before=configRevision(cfg.storage.path);
      cfg=loadConfig(storagePath,overrides);
      const after=configRevision(cfg.storage.path);
      if (before===after) {adoptedRevision=overrides && Object.keys(overrides).length ? undefined : after;break;}
    }

    const db = Database.open(path.join(cfg.storage.path, 'cmm.db'));
    const blobs = new BlobStore(
      path.join(cfg.storage.path, 'blobs'),
      cfg.storage.blobThresholdBytes,
    );
    const baseLogger = createLogger({
      dir: cfg.logging.dir,
      level: cfg.logging.level,
    });
    const runtime = createRuntimeObserver(cfg.storage.path,{...runtimeOptions,configRevision:adoptedRevision});
    const logger = observeFallbackLogger(baseLogger,runtime);
    const providersFor = (role: 'retention'|'capsule'|'chain', configs: ProviderConfig[]): ModelProvider[] => {
      const providers = buildProviders(configs);
      for (let i=0;i<providers.length;i++) {
        const config = configs[i];
        observeProvider(providers[i],() => runtime.operation({kind:'provider',role,provider:config.name,model:config.model}));
      }
      return providers;
    };
    const archive = new ArchiveServiceImpl(db, blobs, logger,source => runtime.operation({kind:'index',
      scope:{agent:source.agent,workspaceId:source.workspaceId},eventId:source.eventId}));
    const recordCall = (r: ProviderCallRecord): void => {
      db.insertProviderCall(r);
    };
    // Cheap model for capsule refinement: model-backed when capsule
    // providers are configured (PRD §17/§18), deterministic otherwise.
    const cheapModel = new ModelBackedCheapModel({
      providers: providersFor('capsule',cfg.providers.capsule),
      recordCall,
      logger,
    });
    const capsules = new ObservedCapsuleBuilder({ db, cheapModel, logger },runtime);
    // Chain linker: rules first, model assist for fuzzy boundaries when
    // chain providers are configured (PRD §16.1).
    const linker = new RuleChainLinker({
      db,
      capsules,
      logger,
      chainProviders: providersFor('chain',cfg.providers.chain),
      recordCall,
    });
    const preset = activePreset(cfg);
    // Primary retention scorer is configurable (PRD §10: Jev is the
    // default implementation, not a hard dependency). Without retention
    // providers Jev can only fail, so score deterministically instead of
    // logging a provider fallback for every event.
    let primary: RetentionScorer;
    if (cfg.retention.scorer === 'conservative' || cfg.providers.retention.length === 0) {
      primary = new ConservativeFallbackScorer();
    } else if (cfg.retention.scorer === 'systemone') {
      primary = new SystemOneScorer({ providers: providersFor('retention',cfg.providers.retention), recordCall, logger });
    } else {
      primary = new JevScorer({
        providers: providersFor('retention',cfg.providers.retention),
        recordCall,
        logger,
      });
    }
    const fallbackScorer = new ConservativeFallbackScorer();
    const pressure = new PressureMonitor(preset);
    const retention = new ObservedRetentionEngine({
      db,
      primary,
      fallback: fallbackScorer,
      capsules,
      logger,
      preset,
      getTurn: (sid: string) => db.getCurrentTurn(sid),
      verifyArchive: (id: string) => archive.fetchOriginal(id),
    },runtime);

    return new ContextManager({
      config: cfg,
      db,
      logger,
      archive,
      capsules,
      retention,
      linker,
      pressure,
      runtime,
    });
  }

  /**
   * Record a completed tool call: archive immediately, then descriptor and
   * chain linking. Archive failure => event stays visible (returns
   * archived:false; never compact unarchived — invariant §7.1).
   * A duplicate (agent, workspace, tool_call_id) is idempotent: the
   * existing event is returned without a second row or re-linking.
   */
  async recordToolComplete(input: ToolEventInput): Promise<RecordResult> {
    let workspaceId: string;
    try { validateToolInput(input); workspaceId = resolveWorkspaceId(this.db,input.agent,input.workspaceId); } catch (error) {
      return {eventId: null, archived: false, internal: false, error: errorMessage(error)};
    }
    // Normalize the workspace id first so every downstream lookup
    // (session, archive, recall, pin) uses one identity (PRD §24).
    const normalized: ToolEventInput = { ...input, workspaceId };
    return this.runtime.withScope({agent:input.agent,workspaceId},() => this.recordNormalized(normalized));
  }

  private async recordNormalized(normalized: ToolEventInput): Promise<RecordResult> {
    if (isInternalTool(normalized.toolName)) {
      this.db.insertAudit(
        normalized.toolName,
        normalized.sessionId,
        'internal manager tool: audit only',
      );
      this.logger.log('internal tool skipped', {
        tool: normalized.toolName,
        sessionId: normalized.sessionId,
      });
      return { eventId: null, archived: false, internal: true };
    }

    let event: ToolEvent;
    let descriptor: ToolDescriptor;
    const endArchive = this.runtime.operation({kind:'archive'});
    try {
      validateToolInput(normalized);
      descriptor = buildDescriptor(normalized.toolName, normalized.input, normalized.result, normalized.status);
      if (normalized.sideEffect) descriptor.isSideEffect = true;
      const saved = await this.archive.archive(normalized, 0, descriptor);
      event = saved;
      endArchive({eventId:event.id});
      if (!saved.inserted) return { eventId: event.id, archived: true, internal: false };
    } catch (error) {
      endArchive({status:'error'});
      this.logger.log('archive failed', { toolCallId: normalized.toolCallId, tool: normalized.toolName, error: errorMessage(error) });
      return { eventId: null, archived: false, internal: false, error: errorMessage(error) };
    }

    this.logger.log('tool archived', {
      eventId: event.id,
      toolCallId: event.toolCallId,
      tool: event.toolName,
      bytes: event.resultRef.bytes,
    });
    this.logger.log('descriptor created', {
      eventId: event.id,
      inputSummary: descriptor.inputSummary,
      salientCount: descriptor.salient.length,
    });
    this.db.bumpStat('tools_archived');

    const endChain = this.runtime.operation({kind:'chain',eventId:event.id});
    try {
      const link = await this.linker.linkEvent(event);
      if (link) {
        this.db.updateToolEvent(event.id, { chain_id: link.chainId });
        event = { ...event, chainId: link.chainId };
        this.logger.log('chain linked', {
          eventId: event.id,
          chainId: link.chainId,
          created: link.created,
        });
        await this.linker.refreshChainCapsule(link.chainId);
        await this.linker.maybeCompleteChain(link.chainId, event);
      }
      endChain();
    } catch (e) {
      endChain({status:'error'});
      this.logger.log('chain linking failed', {
        eventId: event.id,
        error: String(e),
      });
    }

    return { eventId: event.id, archived: true, internal: false };
  }

  /** Record the host's current context-window usage for a session. */
  reportHostUsage(
    sessionId: string,
    usage: { contextWindow: number; usedTokens: number; managedTokens?: number },
  ): void {
    integer(usage.contextWindow, 'contextWindow', 1, 1000000000);
    integer(usage.usedTokens, 'usedTokens', 0, 1000000000);
    const load = this.sessionTokenLoad(sessionId);
    const managed = usage.managedTokens ?? (load.hotTokens + load.capsuleTokens);
    integer(managed, 'managedTokens', 0, 1000000000);
    this.db.setHostUsage(sessionId, usage.contextWindow, usage.usedTokens, managed);
  }

  /** Token load of managed state: HOT event descriptors + capsule summaries. */
  private sessionTokenLoad(sessionId: string): {
    hotTokens: number;
    capsuleTokens: number;
  } {
    let hotTokens = 0;
    for (const r of this.db.listHotEvents(sessionId)) {
      const d = JSON.parse(r.descriptor_json) as ToolDescriptor;
      hotTokens += d.tokenEstimate;
    }
    let capsuleTokens = 0;
    for (const r of this.db.listEvents(sessionId, -1)) {
      if (r.state !== 'capsule' || !r.capsule_id) continue;
      const cap = this.db.getCapsule(r.capsule_id);
      if (cap) {
        const capsule = rowToCapsule(cap);
        capsuleTokens += estimateTokens(
          capsule.summary + '\n' + capsule.facts.join('\n'),
        );
      }
    }
    return { hotTokens, capsuleTokens };
  }

  /**
   * Run tidy passes over the session's HOT events while the adaptive
   * pressure reading stays at/above the strategy release threshold.
   *
   * Each pass scores at most TIDY_BATCH_LIMIT undecided HOT events
   * (bounding scorer cost per pass, PRD §40), applies KEEP/CAPSULE/EVICT,
   * then recomputes pressure from the managed load delta. The loop stops
   * when pressure falls below release, a pass changes no event state,
   * MAX_TIDY_PASSES passes are done, or no undecided HOT events remain.
   * Events never evaluated in this run stay HOT (implicit keep).
   */
  async maybeTidy(sessionId: string, taskHint?: string): Promise<TidyResult> {
    const preset = activePreset(this.config);

    const computeReading = (): {
      pressure: number;
      details: Record<string, number>;
      shouldTidy: boolean;
      contextWindow: number;
      usedTokens: number;
      managedTokens: number;
      hotTokens: number;
      capsuleTokens: number;
    } => {
      const load = this.sessionTokenLoad(sessionId);
      const host = this.db.getHostUsage(sessionId);
      const contextWindow = host?.context_window ?? this.config.integration.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
      const usedTokens =
        host ? Math.max(0, host.used_tokens - host.managed_tokens) + load.hotTokens + load.capsuleTokens : load.hotTokens + load.capsuleTokens;
      const turn = this.db.getCurrentTurn(sessionId);
      const last = this.lastTidy.get(sessionId);
      const growthPerTurn =
        last && turn > last.turn
          ? Math.max(0, (usedTokens - last.used) / (turn - last.turn))
          : 0;
      const turnsSinceTidy = last ? turn - last.turn : turn;
      const reading = this.pressure.compute({
        contextWindow,
        usedTokens,
        hotTokens: load.hotTokens,
        capsuleTokens: load.capsuleTokens,
        growthPerTurn,
        turnsSinceTidy,
      });
      return {
        pressure: reading.pressure,
        details: reading.details,
        shouldTidy: reading.shouldTidy,
        contextWindow,
        usedTokens,
        managedTokens: load.hotTokens + load.capsuleTokens,
        hotTokens: load.hotTokens,
        capsuleTokens: load.capsuleTokens,
      };
    };

    const first = computeReading();
    if (!first.shouldTidy) {
      this.logger.log('pressure checked', {
        sessionId,
        pressure: first.pressure,
        shouldTidy: false,
      });
      return {
        evaluated: 0,
        kept: 0,
        capsuled: 0,
        evicted: 0,
        pressureBefore: first.pressure,
        pressureAfter: first.pressure,
        passes: 0,
        decisions: [],
      };
    }

    const pressureBefore = first.pressure;
    this.logger.log('context pressure triggered', {
      sessionId,
      pressure: pressureBefore,
      details: first.details,
    });

    const decisions: DecisionDetail[] = [];
    const decided = new Set<string>();
    let passes = 0;
    let pressure = pressureBefore;
    let usedTokens = first.usedTokens;
    let managedTokens = first.managedTokens;
    const contextWindow = first.contextWindow;

    // Loop to release: after each pass recompute pressure from the managed
    // load delta so before/after stay comparable (the host's window usage
    // includes our managed content 1:1).
    while (passes < MAX_TIDY_PASSES) {
      const hot = this.db
        .listHotEvents(sessionId)
        .map(rowToToolEvent)
        .filter((e) => !decided.has(e.id))
        .slice(0, TIDY_BATCH_LIMIT);
      if (hot.length === 0) break;
      passes++;

      const batch = await this.retention.decideAll(hot, {
        pressure,
        taskHint,
      });
      let changed = 0;
      for (const d of batch) {
        decided.add(d.eventId);
        decisions.push(d);
        if (d.decision !== 'keep') changed++;
      }
      this.logger.log('tidy pass', {
        sessionId,
        pass: passes,
        evaluated: batch.length,
        changed,
        pressure,
      });

      const load = this.sessionTokenLoad(sessionId);
      const managedAfter = load.hotTokens + load.capsuleTokens;
      usedTokens = Math.max(0, usedTokens - managedTokens + managedAfter);
      managedTokens = managedAfter;
      const after = this.pressure.compute({
        contextWindow,
        usedTokens,
        hotTokens: load.hotTokens,
        capsuleTokens: load.capsuleTokens,
        growthPerTurn: 0,
        turnsSinceTidy: 0,
      });
      pressure = after.pressure;

      if (pressure < preset.release || changed === 0) break;
    }

    const kept = decisions.filter((d) => d.decision === 'keep').length;
    const capsuled = decisions.filter((d) => d.decision === 'capsule').length;
    const evicted = decisions.filter((d) => d.decision === 'evict').length;

    this.lastTidy.set(sessionId, {
      turn: this.db.getCurrentTurn(sessionId),
      used: usedTokens,
    });
    this.db.bumpStat('tidy_runs');

    return {
      evaluated: decisions.length,
      kept,
      capsuled,
      evicted,
      pressureBefore,
      pressureAfter: pressure,
      passes,
      decisions,
    };
  }

  /**
   * Recall an archived event by (agent, workspaceId, toolCallId): restore the
   * EXACT original input+result from the archive, promote the event to HOT,
   * and grant minimum protection turns (invariant §7.3). Cross-session
   * recall works (lookup ignores session); cross-agent isolation holds
   * because lookup is keyed by (agent, workspaceId).
   *
   * A different opts.sessionId receives an independent view and protection
   * window. The source event's session and provenance remain immutable.
   */
  async recall(toolCallId: string, agent: string, workspaceId: string,
    opts?: {sessionId?: string; sourceSessionId?: string}): Promise<RecallResult> {
    const ws = resolveWorkspaceId(this.db,agent,workspaceId);
    const row = this.db.getToolEventByCallId(agent, ws, toolCallId, opts?.sourceSessionId);
    if (!row) throw new RecallError(`no archived event for tool_call_id ${toolCallId}`);
    return this.recallEvent(row.id, agent, ws, opts?.sessionId);
  }

  /** Immutable event ID is the unambiguous recall handle, even across sessions. */
  async recallEvent(eventId: string, agent: string, workspaceId: string, targetSessionId?: string): Promise<RecallResult> {
    const ws = resolveWorkspaceId(this.db,agent,workspaceId);
    const row = this.db.getToolEvent(eventId);
    if (!row || row.agent !== agent || row.workspace_id !== ws) throw new RecallError('event not found in this agent/workspace');
    const original = await this.archive.fetchOriginal(eventId);
    const sessionId = targetSessionId ?? row.session_id;
    this.db.transaction(() => {
      this.db.ensureSession(agent, ws, sessionId);
      this.db.promoteView(eventId, sessionId, activePreset(this.config).minProtectionTurns);
      const turn = this.db.getCurrentTurn(sessionId);
      const decisionTurn = this.db.lastDecisionTurn(eventId);
      this.db.insertRecallLog({eventId,toolCallId: row.tool_call_id,agent,workspaceId: ws,turn,
        decisionTurn,turnsUntilRecall: row.session_id === sessionId && decisionTurn !== null ? Math.max(0,turn-decisionTurn) : null,
        safeToEvict: row.safe_to_evict,decision: this.db.lastDecision(eventId)});
      this.db.bumpStat('recalls');
    });
    this.logger.log('recalled', {eventId, sessionId, sourceSessionId: row.session_id});
    return {eventId,toolCallId: row.tool_call_id,...original};
  }

  /** Recompute the denormalized pinned flags from the pins table. */
  private refreshPinFlag(eventId: string): void {
    const pins = this.db.listPinsForTarget('event', eventId);
    this.db.updateToolEvent(eventId, {
      pinned: pins.length > 0 ? 1 : 0,
      persistent_pin: pins.some((p) => p.persistent === 1) ? 1 : 0,
    });
  }

  /** Resolve a pin target to its event/chain row (workspace normalized). */
  private resolvePinTarget(target: {
    toolCallId?: string;
    chainId?: string;
    agent?: string;
    workspaceId?: string;
  }): { kind: 'event'; id: string } | { kind: 'chain'; id: string } {
    if (target.toolCallId) {
      if (!target.agent || !target.workspaceId) {
        throw new Error('pin by toolCallId requires agent and workspaceId');
      }
      const wsId = resolveWorkspaceId(this.db,target.agent,target.workspaceId);
      const row = this.db.getToolEventByCallId(
        target.agent,
        wsId,
        target.toolCallId,
      );
      if (!row) throw new RecallError('not found');
      return { kind: 'event', id: row.id };
    }
    if (target.chainId) {
      const chain = this.db.getChain(target.chainId);
      if (!chain) throw new Error('chain not found');
      return { kind: 'chain', id: chain.id };
    }
    throw new Error('pin requires toolCallId or chainId');
  }

  /**
   * Pin an event or a whole chain (all its member events) so the retention
   * engine keeps it. sessionId scopes the pin: a pin for session A does not
   * protect the event in session B's tidy (a null sessionId is a global
   * pin). persistent marks it as surviving tidy passes indefinitely.
   */
  async pin(
    target: {
      toolCallId?: string;
      chainId?: string;
      agent?: string;
      workspaceId?: string;
    },
    opts?: { persistent?: boolean; sessionId?: string },
  ): Promise<void> {
    const persistent = opts?.persistent ?? false;
    const sessionId = opts?.sessionId ?? null;
    const resolved = this.resolvePinTarget(target);

    if (resolved.kind === 'event') {
      this.db.insertPin('event', resolved.id, sessionId, persistent);
      this.refreshPinFlag(resolved.id);
      this.logger.log('pinned', { eventId: resolved.id, persistent, sessionId });
    } else {
      this.db.insertPin('chain', resolved.id, sessionId, persistent);
      for (const m of this.db.getChainEvents(resolved.id)) {
        this.refreshPinFlag(m.id);
      }
      this.logger.log('pinned', { chainId: resolved.id, persistent, sessionId });
    }
  }

  /**
   * Reverse of pin. Without opts.sessionId, removes the pin in every
   * session; otherwise only that session's pin.
   */
  async unpin(
    target: {
      toolCallId?: string;
      chainId?: string;
      agent?: string;
      workspaceId?: string;
    },
    opts?: { sessionId?: string },
  ): Promise<void> {
    const sessionId = opts?.sessionId; // undefined => all sessions
    const resolved = this.resolvePinTarget(target);

    if (resolved.kind === 'event') {
      this.db.deletePin('event', resolved.id, sessionId);
      this.refreshPinFlag(resolved.id);
      this.logger.log('unpinned', { eventId: resolved.id, sessionId });
    } else {
      this.db.deletePin('chain', resolved.id, sessionId);
      for (const m of this.db.getChainEvents(resolved.id)) {
        this.refreshPinFlag(m.id);
      }
      this.logger.log('unpinned', { chainId: resolved.id, sessionId });
    }
  }

  /** Operational snapshot: counters, events by state, archive bytes, tokens saved. */
  getStats(): StatsSnapshot {
    const counters = this.db.getStats();
    const byState = this.db.countEventsByState();
    const eventsByState: Record<ToolState, number> = {
      hot: byState.hot ?? 0,
      capsule: byState.capsule ?? 0,
      evicted: byState.evicted ?? 0,
    };
    return {
      counters,
      eventsByState,
      archiveBytes: this.db.sumEventBytes(),
      tokensSavedEstimate: counters['tokens_saved_estimate'] ?? 0,
    };
  }

  /**
   * Garbage-collect cold archive data (PRD §23).
   *
   * Enforces storage.retentionDays / storage.maxSizeBytes. Only COLD data
   * is ever removed: candidates are EVICTED events only — never HOT, never
   * capsule-state (capsule blobs back the archive), never pinned (in any
   * session), never under recall or active-chain protection. Victims are deleted
   * oldest-evicted-first; blob files are removed only when no remaining
   * event references their content hash (dedup safety). With no caps
   * configured this is a no-op.
   */
  async gc(): Promise<GcResult> {
    const { retentionDays, maxSizeBytes } = this.config.storage;
    if (retentionDays == null && maxSizeBytes == null) {
      this.logger.log('gc skipped', { reason: 'no retention caps configured' });
      return { deletedEvents: 0, freedBytes: 0, blobsDeleted: 0 };
    }

    let deletedEvents = 0;
    let freedBytes = 0;
    let blobsDeleted = 0;

    /** Conservative: any pin (any session) or live protection blocks GC. */
    const isProtected = (row: ToolEventRow): boolean => {
      if (this.db.listPinsForTarget('event', row.id).length > 0) return true;
      if (row.chain_id && this.db.listPinsForTarget('chain', row.chain_id).length > 0) return true;
      const live = this.db.queryOne<{n: number}>(
        "SELECT count(*) AS n FROM event_views v JOIN sessions s ON s.id=v.session_id WHERE v.event_id=? AND (v.state!='evicted' OR v.protected_until_turn>s.current_turn)", [row.id]);
      if (live && live.n > 0) return true;
      return Boolean(eventProtectionReason(this.db, row, activePreset(this.config).minProtectionTurns));
    };

    const deleteVictim = (row: ToolEventRow): void => {
      // First retire the record transactionally; a crash can only leave an orphan blob.
      const retired = this.db.transaction(() => {
        const fresh = this.db.getToolEvent(row.id);
        if (!fresh || fresh.state !== 'evicted' || isProtected(fresh)) return false;
        this.db.deleteEventCascade(row.id);
        return true;
      });
      if (!retired) return;
      const refs: ContentRef[] = [
        {
          kind: row.input_kind,
          ref: row.input_ref,
          sha256: row.input_sha,
          bytes: row.input_bytes,
        },
        {
          kind: row.result_kind,
          ref: row.result_ref,
          sha256: row.result_sha,
          bytes: row.result_bytes,
        },
      ];
      for (const ref of refs) {
        if (this.archive.deleteUnreferencedBlob(ref, row.id)) blobsDeleted++;
        freedBytes += ref.bytes;
      }
      deletedEvents++;
      this.logger.log('gc deleted event', {
        eventId: row.id,
        toolCallId: row.tool_call_id,
      });
    };

    if (retentionDays != null) {
      const cutoff = Date.now() - retentionDays * 86_400_000;
      for (const row of this.db.listColdEvicted(cutoff,1000000)) {
        if (!isProtected(row)) deleteVictim(row);
      }
    }

    if (maxSizeBytes != null) {
      let guard = 0;
      while (this.db.sumEventBytes() > maxSizeBytes && guard++ < 1000) {
        const batch = this.db.listColdEvicted(null, 1000000);
        if (batch.length === 0) break;
        let progressed = false;
        for (const row of batch) {
          if (this.db.sumEventBytes() <= maxSizeBytes) break;
          if (isProtected(row)) continue;
          deleteVictim(row);
          progressed = true;
        }
        if (!progressed) break; // remaining cold events are all protected
      }
    }

    this.db.bumpStat('gc_runs');
    this.db.bumpStat('gc_events_deleted', deletedEvents);
    this.logger.log('gc completed', { deletedEvents, freedBytes, blobsDeleted });
    return { deletedEvents, freedBytes, blobsDeleted };
  }

  close(): void {
    this.runtime.close();
    this.db.close();
    this.logger.close();
  }
}
