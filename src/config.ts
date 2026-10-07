import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Config, ProviderConfig, StrategyName, StrategyPreset } from './types.js';
import { atomicCreate, atomicWrite } from './util/atomic.js';
import { integer, object, errorMessage } from './util/validation.js';

export function defaultStoragePath(): string {
  return path.resolve(process.env.CMM_STORAGE ?? path.join(os.homedir(), '.context-memory-manager'));
}
const STRATEGIES: Record<StrategyName, StrategyPreset> = {
  conservative: { trigger: 0.8, release: 0.62, keepThreshold: 0.6, evictThreshold: 0.95, minProtectionTurns: 5 },
  balanced: { trigger: 0.65, release: 0.48, keepThreshold: 0.5, evictThreshold: 0.9, minProtectionTurns: 3 },
  aggressive: { trigger: 0.5, release: 0.35, keepThreshold: 0.35, evictThreshold: 0.8, minProtectionTurns: 2 },
};
export function defaultConfig(storagePath?: string): Config {
  const p = path.resolve(storagePath ?? defaultStoragePath());
  return {
    strategy: 'balanced', strategies: structuredClone(STRATEGIES), retention: { scorer: 'jev' },
    storage: { path: p, retentionDays: null, maxSizeBytes: null, blobThresholdBytes: 8192 },
    providers: { retention: [], capsule: [], chain: [] }, models: { cheapModel: null },
    logging: { level: 'info', dir: path.join(p, 'logs') },
    integration: { contextWindow: 200000, maxOutputChars: 12000, minSavingsChars: 512, captureOnly: false, ingressCompression: false, minHistorySavingsChars: 2048, historyCooldownTurns: 3, rtkDatabasePath: null },
  };
}
function merge(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(overrides)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error(`unsafe config key: ${key}`);
    if (!(key in base)) throw new Error(`unknown config key: ${key}`);
    out[key] = value && typeof value === 'object' && !Array.isArray(value)
      && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])
      ? merge(base[key] as Record<string, unknown>, value as Record<string, unknown>) : structuredClone(value);
  }
  return out;
}
export function validateConfig(cfg: Config): Config {
  if (!['balanced', 'conservative', 'aggressive'].includes(cfg.strategy)) throw new Error('strategy must be balanced, conservative, or aggressive');
  for (const [name, preset] of Object.entries(object(cfg.strategies, 'strategies'))) {
    const p = object(preset, `strategies.${name}`);
    for (const k of ['trigger', 'release', 'keepThreshold', 'evictThreshold']) {
      const v = p[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) throw new Error(`strategies.${name}.${k} must be in [0,1]`);
    }
    if ((p.release as number) >= (p.trigger as number)) throw new Error(`strategies.${name}.release must be below trigger`);
    if ((p.keepThreshold as number) >= (p.evictThreshold as number)) throw new Error(`strategies.${name}.keepThreshold must be below evictThreshold`);
    integer(p.minProtectionTurns, `strategies.${name}.minProtectionTurns`, 1, 10000);
  }
  if (!['jev', 'conservative'].includes(cfg.retention?.scorer)) throw new Error('retention.scorer must be jev or conservative');
  const s = object(cfg.storage, 'storage');
  integer(s.blobThresholdBytes, 'storage.blobThresholdBytes', 0, 64 * 1024 * 1024);
  for (const k of ['retentionDays', 'maxSizeBytes']) if (s[k] !== null) integer(s[k], `storage.${k}`, 0, Number.MAX_SAFE_INTEGER);
  for (const purpose of ['retention', 'capsule', 'chain'] as const) {
    const entries = cfg.providers?.[purpose];
    if (!Array.isArray(entries) || entries.length > 8) throw new Error(`providers.${purpose} must be an array (at most 8)`);
    entries.forEach((entry: ProviderConfig) => {
      object(entry, 'provider');
      if (!['openai-compatible', 'anthropic', 'gemini', 'fake'].includes(entry.kind)) throw new Error('unsupported provider kind');
      if (!entry.name || !entry.model || typeof entry.name !== 'string' || typeof entry.model !== 'string') throw new Error('provider name/model are required');
      for(const key of ['apiKey','apiKeyEnv','baseUrl'] as const)if(entry[key]!==undefined && typeof entry[key]!=='string')throw new Error(`provider.${key} must be a string`);
      if(entry.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.apiKeyEnv))throw new Error('Invalid API key environment variable');
      if (entry.baseUrl) {
        const url = new URL(entry.baseUrl);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('provider baseUrl must be HTTP(S), without embedded credentials');
      }
    });
  }
  if (!['debug', 'info', 'warn', 'error'].includes(cfg.logging?.level)) throw new Error('invalid logging.level');
  if (cfg.logging.dir !== null && typeof cfg.logging.dir !== 'string') throw new Error('logging.dir must be a path or null');
  const i = object(cfg.integration, 'integration');
  integer(i.contextWindow, 'integration.contextWindow', 1024, 100000000);
  integer(i.maxOutputChars, 'integration.maxOutputChars', 1024, 10000000);
  integer(i.minSavingsChars, 'integration.minSavingsChars', 1, 1000000);
  if (typeof i.captureOnly !== 'boolean') throw new Error('integration.captureOnly must be boolean');
  if (typeof i.ingressCompression !== 'boolean') throw new Error('integration.ingressCompression must be boolean');
  integer(i.minHistorySavingsChars, 'integration.minHistorySavingsChars', 1, 10000000);
  integer(i.historyCooldownTurns, 'integration.historyCooldownTurns', 0, 10000);
  if (i.rtkDatabasePath !== null && (typeof i.rtkDatabasePath !== 'string' || !i.rtkDatabasePath.trim())) throw new Error('integration.rtkDatabasePath must be a path or null');
  return cfg;
}
export function loadConfig(storagePath?: string, overrides?: Record<string, unknown>): Config {
  const base = defaultConfig(storagePath);
  const file = path.join(base.storage.path, 'config.json');
  let disk: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    try { disk = object(JSON.parse(fs.readFileSync(file, 'utf8')), 'config'); }
    catch (error) { throw new Error(`Cannot read ${file}; configuration was not reset. ${errorMessage(error)}`); }
  }
  const merged = merge(merge(base as unknown as Record<string, unknown>, disk), overrides ?? {}) as unknown as Config;
  merged.storage.path = base.storage.path;
  return validateConfig(merged);
}
export function saveConfig(cfg: Config): void {
  validateConfig(cfg);
  atomicWrite(path.join(cfg.storage.path, 'config.json'), JSON.stringify(cfg, null, 2) + '\n');
}
/** Initial creation never replaces settings published by another opener. */
export function createConfigIfAbsent(cfg: Config): boolean {
  validateConfig(cfg);
  return atomicCreate(path.join(cfg.storage.path, 'config.json'), JSON.stringify(cfg, null, 2) + '\n');
}
export function activePreset(cfg: Config): StrategyPreset { return cfg.strategies[cfg.strategy]; }
export function redactConfig(cfg: Config): Record<string, unknown> {
  return JSON.parse(JSON.stringify(cfg, (key, value: unknown) => /^(apiKey|authorization|password|token|secret)$/i.test(key) && value ? '[REDACTED]' : value));
}
