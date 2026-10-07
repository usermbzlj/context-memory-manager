/**
 * Public API surface of the Context Memory Manager.
 *
 * Most consumers only need `ContextManager`; the rest is exported for
 * adapters, tooling, and tests.
 */
export { ContextManager } from './core/context-manager.js';

export {
  loadConfig,
  saveConfig,
  defaultConfig,
  activePreset,
  defaultStoragePath,
} from './config.js';

export { createLogger } from './logging.js';

export {
  buildDescriptor,
  isSideEffectTool,
  isInternalTool,
  estimateTokens,
} from './descriptor.js';

export { ConservativeFallbackScorer } from './scoring/fallback.js';
export { JevScorer } from './scoring/jev.js';

export {
  DeterministicCheapModel,
  ModelBackedCheapModel,
  CapsuleBuilderImpl,
} from './capsule/compressor.js';

export { normalizeWorkspaceId } from './storage/archive.js';

export { buildProviders } from './providers/index.js';
export { FakeProvider } from './providers/fake.js';

export type * from './types.js';

export { MemoryService, sessionKey } from './runtime/memory.js';
export type { MemoryScope, Capture, Projection } from './runtime/memory.js';
export { serveMemory } from './mcp/server.js';
export { MEMORY_TOOLS, executeMemoryTool } from './mcp/tools.js';
export { MemoryProxy } from './mcp/proxy.js';
export { RpcClient } from './runtime/rpc-client.js';

export type { EvidenceProvenance } from './evidence/provenance.js';
export { readRtkEvidence, importRtkEvidence } from './integrations/rtk.js';
export type { RtkImportOptions } from './integrations/rtk.js';
