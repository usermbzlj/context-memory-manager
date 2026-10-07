import type { EvidenceProvenance } from './evidence/provenance.js';
/**
 * Shared domain types and cross-module service contracts.
 *
 * Everything in here is intentionally free of any single coding-agent's
 * concepts: core logic must stay independent of adapters (PRD §51).
 */

// ---------------------------------------------------------------------------
// Basic domain types
// ---------------------------------------------------------------------------

export type AgentId = string;
export type SessionId = string;
export type WorkspaceId = string;

export type ToolState = 'hot' | 'capsule' | 'evicted';
export type RetentionDecision = 'keep' | 'capsule' | 'evict';
export type EventStatus = 'ok' | 'error';
export type ChainStatus = 'active' | 'completed';

/** Raw tool completion as observed by an adapter. */
export interface ToolEventInput {
  /** Trusted capture metadata; never inferred as complete from a hash alone. */
  provenance?: EvidenceProvenance;
  agent: AgentId;
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  toolCallId: string;
  toolName: string;
  /** Trusted adapter hint: false is not proof of safety; true forces protection. */
  sideEffect?: boolean;
  /** Raw tool input (command line, parameters) as text. */
  input: string;
  /** Raw tool result text. */
  result: string;
  status: EventStatus;
}

/** Deterministic, locally-extracted description of a tool interaction. */
export interface ToolDescriptor {
  tool: string;
  status: EventStatus;
  sizeChars: number;
  tokenEstimate: number;
  /** One-line summary of the input, e.g. the command or `Read <path>`. */
  inputSummary: string;
  /** High-signal lines: errors, test verdicts, paths, exit codes... */
  salient: string[];
  paths: string[];
  exitCode?: number;
  /** e.g. "83 passed, 1 failed" */
  testVerdict?: string;
  /** Short outcome string when determinable, e.g. "test failure". */
  outcome?: string;
  isSideEffect: boolean;
}

/** Reference to archived content: small content lives inline in SQLite,
 *  large content lives in the external blob store (SHA-256 addressed). */
export interface ContentRef {
  kind: 'inline' | 'blob';
  /** inline: the literal text. blob: path relative to the blob root. */
  ref: string;
  sha256: string;
  bytes: number;
}

export interface ToolEvent {
  id: string;
  agent: AgentId;
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  toolCallId: string;
  toolName: string;
  status: EventStatus;
  /** Monotonic per-session turn counter value when the event was recorded. */
  turn: number;
  createdAt: number;
  archivedAt: number;
  /** Archive write confirmed (invariant §7.1: never compact before this). */
  archived: boolean;
  inputRef: ContentRef;
  resultRef: ContentRef;
  descriptor: ToolDescriptor;
  chainId?: string;
  pinned: boolean;
  persistentPin: boolean;
  state: ToolState;
  safeToEvict?: number;
  /** Turn until which the event is protected (recall protection etc.). */
  protectedUntilTurn: number;
  recalledCount: number;
  lastRecalledAt?: number;
  capsuleId?: string;
}

export interface MemoryCapsule {
  id: string;
  sourceEventIds: string[];
  summary: string;
  facts: string[];
  anchors: string[];
  outcome?: string;
  frozen: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ToolChain {
  id: string;
  agent: AgentId;
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  status: ChainStatus;
  eventIds: string[];
  capsuleId?: string;
  createdAt: number;
  updatedAt: number;
}

/** Draft capsule produced by deterministic extraction before cheap-model refine. */
export interface CapsuleDraft {
  summary: string;
  facts: string[];
  anchors: string[];
  outcome?: string;
}

// ---------------------------------------------------------------------------
// Flat DB row shapes (snake_case, as stored in SQLite)
// ---------------------------------------------------------------------------

export interface ToolEventRow {
  id: string;
  agent: string;
  workspace_id: string;
  session_id: string;
  tool_call_id: string;
  tool_name: string;
  status: EventStatus;
  turn: number;
  created_at: number;
  archived_at: number;
  input_kind: 'inline' | 'blob';
  input_ref: string;
  input_sha: string;
  input_bytes: number;
  result_kind: 'inline' | 'blob';
  result_ref: string;
  result_sha: string;
  result_bytes: number;
  descriptor_json: string;
  chain_id: string | null;
  pinned: number;
  persistent_pin: number;
  state: ToolState;
  safe_to_evict: number | null;
  protected_until_turn: number;
  recalled_count: number;
  last_recalled_at: number | null;
  capsule_id: string | null;
}

export interface ChainRow {
  id: string;
  agent: string;
  workspace_id: string;
  session_id: string;
  status: ChainStatus;
  capsule_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface CapsuleRow {
  id: string;
  source_event_ids_json: string;
  summary: string;
  facts_json: string;
  anchors_json: string;
  outcome: string | null;
  frozen: number;
  created_at: number;
  updated_at: number;
}

export function contentRefFromRow(
  kind: 'inline' | 'blob',
  ref: string,
  sha: string,
  bytes: number,
): ContentRef {
  return { kind, ref, sha256: sha, bytes };
}

export function rowToToolEvent(row: ToolEventRow): ToolEvent {
  return {
    id: row.id,
    agent: row.agent,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    status: row.status,
    turn: row.turn,
    createdAt: row.created_at,
    archivedAt: row.archived_at,
    archived: true,
    inputRef: contentRefFromRow(row.input_kind, row.input_ref, row.input_sha, row.input_bytes),
    resultRef: contentRefFromRow(row.result_kind, row.result_ref, row.result_sha, row.result_bytes),
    descriptor: JSON.parse(row.descriptor_json) as ToolDescriptor,
    chainId: row.chain_id ?? undefined,
    pinned: row.pinned === 1,
    persistentPin: row.persistent_pin === 1,
    state: row.state,
    safeToEvict: row.safe_to_evict ?? undefined,
    protectedUntilTurn: row.protected_until_turn,
    recalledCount: row.recalled_count,
    lastRecalledAt: row.last_recalled_at ?? undefined,
    capsuleId: row.capsule_id ?? undefined,
  };
}

export function rowToChain(row: ChainRow, eventIds: string[]): ToolChain {
  return {
    id: row.id,
    agent: row.agent,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    status: row.status,
    eventIds,
    capsuleId: row.capsule_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToCapsule(row: CapsuleRow): MemoryCapsule {
  return {
    id: row.id,
    sourceEventIds: JSON.parse(row.source_event_ids_json) as string[],
    summary: row.summary,
    facts: JSON.parse(row.facts_json) as string[],
    anchors: JSON.parse(row.anchors_json) as string[],
    outcome: row.outcome ?? undefined,
    frozen: row.frozen === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export type StrategyName = 'conservative' | 'balanced' | 'aggressive';

export interface ProviderConfig {
  kind: 'openai-compatible' | 'anthropic' | 'gemini' | 'fake';
  name: string;
  model: string;
  baseUrl?: string;
  /** Literal API key (prefer apiKeyEnv). */
  apiKey?: string;
  /** Environment variable holding the API key. */
  apiKeyEnv?: string;
}

export interface StrategyPreset {
  /** Pressure level (0..1) at which a tidy pass starts. */
  trigger: number;
  /** Tidy until pressure falls below this. */
  release: number;
  /** score < keepThreshold  => KEEP */
  keepThreshold: number;
  /** score >= evictThreshold => EVICT (else CAPSULE) */
  evictThreshold: number;
  /** Minimum protection turns after a recall. */
  minProtectionTurns: number;
}

export interface Config {
  integration: {
    contextWindow: number;
    maxOutputChars: number;
    minSavingsChars: number;
    captureOnly: boolean;
    /** Ingress filtering is opt-in; default behavior preserves first-use evidence. */
    ingressCompression: boolean;
    /** Coalesce history rewrites rather than churn a cached prefix each call. */
    minHistorySavingsChars: number;
    historyCooldownTurns: number;
    /** Explicit opt-in path; only read matching-workspace RTK rows. */
    rtkDatabasePath: string | null;
  };
  strategy: StrategyName;
  strategies: Record<StrategyName, StrategyPreset>;
  retention: {
    /** Primary retention scorer: 'jev' (model-backed, default) or 'conservative' (deterministic). */
    scorer: 'jev' | 'conservative';
  };
  storage: {
    /** Root dir for sqlite file, blobs, logs, config.json */
    path: string;
    retentionDays: number | null;
    maxSizeBytes: number | null;
    /** Content larger than this goes to the blob store; smaller stays inline. */
    blobThresholdBytes: number;
  };
  providers: {
    retention: ProviderConfig[];
    capsule: ProviderConfig[];
    chain: ProviderConfig[];
  };
  models: {
    /** Reserved for a real cheap model later; null => deterministic stub. */
    cheapModel: string | null;
  };
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
    /** null disables file logging */
    dir: string | null;
  };
}

// ---------------------------------------------------------------------------
// Service contracts
// ---------------------------------------------------------------------------

export interface ScorerContext {
  recentDescriptors: ToolDescriptor[];
  chainSummary?: string;
  pressure: number;
  currentTurn: number;
  taskHint?: string;
}

/** Unified retention scorer. V1 default implementation is Jev-shaped
 *  (model-backed); the deterministic fallback is always available. */
export interface RetentionScorer {
  readonly name: string;
  /** Returns safeToEvict in [0,1]. May throw (provider failure etc.). */
  score(event: ToolEvent, ctx: ScorerContext): Promise<number>;
  /**
   * Optional batched scoring: one score per item, in the same order.
   * Whole-batch failure must throw so the caller can fall back.
   */
  scoreBatch?(items: BatchScoreItem[]): Promise<number[]>;
}

/** One element of a batched scoring request. */
export interface BatchScoreItem {
  event: ToolEvent;
  ctx: ScorerContext;
}

export interface CheapModel {
  readonly name: string;
  refine(draft: CapsuleDraft, event: ToolEvent): Promise<CapsuleDraft>;
}

export interface CapsuleBuilder {
  build(event: ToolEvent): Promise<MemoryCapsule>;
  buildChainCapsule(chain: ToolChain, events: ToolEvent[]): Promise<MemoryCapsule>;
  freezeChainCapsule(chainId: string): Promise<void>;
  /** Test hook: the next build()/buildChainCapsule() throws. */
  failNextBuild(): void;
}

export interface CompletionRequest {
  system?: string;
  user: string;
  jsonMode?: boolean;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface CompletionResponse {
  text: string;
  tokensIn: number;
  tokensOut: number;
  model: string;
}

export interface ModelProvider {
  readonly name: string;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
}

export interface ProviderCallRecord {
  provider: string;
  model: string;
  purpose: 'retention' | 'capsule' | 'chain';
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  ok: boolean;
  error?: string;
}

export interface ChainLinkResult {
  chainId: string;
  created: boolean;
}

export interface ChainLinker {
  linkEvent(event: ToolEvent): Promise<ChainLinkResult | null>;
  refreshChainCapsule(chainId: string): Promise<void>;
  /** Returns true when the chain was completed by this event. */
  maybeCompleteChain(chainId: string, event: ToolEvent): Promise<boolean>;
}

export class ArchiveError extends Error {
  constructor(message: string, opts?: { cause?: unknown }) {
    super(message, opts as ErrorOptions);
    this.name = 'ArchiveError';
  }
}

export class CapsuleError extends Error {
  constructor(message: string, opts?: { cause?: unknown }) {
    super(message, opts as ErrorOptions);
    this.name = 'CapsuleError';
  }
}

export class RecallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecallError';
  }
}

export interface ArchiveService {
  archive(input: ToolEventInput, turn: number, descriptor: ToolDescriptor): Promise<ToolEvent>;
  /** Restores the EXACT original input + result from the archive. */
  fetchOriginal(eventId: string): Promise<{ input: string; result: string }>;
  /** Test hook: the next archive() throws ArchiveError. */
  failNextArchive(): void;
}

export interface PressureReading {
  pressure: number;
  trigger: number;
  release: number;
  shouldTidy: boolean;
  details: Record<string, number>;
}

export interface Logger {
  log(event: string, fields?: Record<string, unknown>): void;
  child(extra: Record<string, unknown>): Logger;
  close(): void;
}

// ---------------------------------------------------------------------------
// ContextManager public shapes
// ---------------------------------------------------------------------------

export interface RecordResult {
  eventId: string | null;
  archived: boolean;
  /** A duplicate identity with different content is a conflict, never success. */
  error?: string;
  /** True when the tool was an internal manager tool (audit-log only). */
  internal: boolean;
}

export interface DecisionDetail {
  eventId: string;
  toolCallId: string;
  toolName: string;
  decision: RetentionDecision;
  reason: string;
  score?: number;
}

export interface TidyResult {
  evaluated: number;
  kept: number;
  capsuled: number;
  evicted: number;
  pressureBefore: number;
  pressureAfter: number;
  /** Number of scoring passes executed (loop to release). */
  passes: number;
  decisions: DecisionDetail[];
}

export interface RecallResult {
  eventId: string;
  toolCallId: string;
  input: string;
  result: string;
}

export interface StatsSnapshot {
  counters: Record<string, number>;
  eventsByState: Record<ToolState, number>;
  archiveBytes: number;
  tokensSavedEstimate: number;
}

/** Result of an archive garbage-collection run (cold evicted data only). */
export interface GcResult {
  deletedEvents: number;
  freedBytes: number;
  blobsDeleted: number;
}
