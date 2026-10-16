import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
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
    if (!Object.hasOwn(base, key)) throw new Error(`unknown config key: ${key}`);
    out[key] = value && typeof value === 'object' && !Array.isArray(value)
      && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])
      ? merge(base[key] as Record<string, unknown>, value as Record<string, unknown>) : structuredClone(value);
  }
  return out;
}
/** Save and load must accept the same keys; invalid replacements never reach disk. */
function configObject(value: unknown, label: string, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const fields = object(value, label);
  for (const key of Object.keys(fields)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error(`unsafe config key: ${key}`);
    if (!required.includes(key) && !optional.includes(key)) throw new Error(`unknown config key: ${label}.${key}`);
  }
  for (const key of required) if (!Object.hasOwn(fields, key)) throw new Error(`missing config key: ${label}.${key}`);
  return fields;
}
/**
 * True for a loopback host in every form `new URL()` can produce:
 * `localhost`, `[::1]`, dotted-quad `127.x.x.x`, or an IPv6-mapped
 * 127.0.0.0/8 address. `new URL()` normalizes every mapped spelling
 * (`::ffff:127.0.0.1`, `::ffff:7f00:0001`) to `[::ffff:7f00:1]`, so the
 * check must accept hex-word mapped forms or a dual-stack local provider
 * is misclassified as remote cleartext.
 */
export function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  const lower = hostname.toLowerCase();
  if (!lower.startsWith('[::ffff:') || !lower.endsWith(']')) return false;
  const inner = lower.slice(8, -1);
  if (inner.includes('.')) {
    const octets = inner.split('.');
    return octets.length === 4 && octets[0] === '127' && octets.slice(1).every(part => /^\d{1,3}$/.test(part));
  }
  const words = inner.split(':');
  if (words.length === 0 || words.length > 2) return false;
  if (!words.every(word => /^[0-9a-f]{1,4}$/.test(word))) return false;
  // Network order: the first hex word holds the high 16 bits of the IPv4 address.
  return parseInt(words[0].padStart(4, '0').slice(0, 2), 16) === 127;
}
/** True when a credential would travel over plain http to a non-loopback host. */
export function cleartextRemote(baseUrl: string): boolean {
  const url = new URL(baseUrl);
  return url.protocol === 'http:' && !isLoopbackHost(url.hostname);
}
const SAME_ENTRY = ['kind', 'model', 'baseUrl', 'apiKey', 'apiKeyEnv', 'reasoningEffort'] as const;
/**
 * `previous` adds checks that new settings must satisfy: `null` checks every provider entry (a brand-new file),
 * a Config checks only entries that are new or changed against it (by purpose + name), so a legacy entry never
 * blocks an unrelated save. Loading (undefined) stays permissive so an older file never stops hooks from
 * capturing; providers refuse those requests instead.
 */
export function validateConfig(cfg: Config, previous?: Config | null): Config {
  configObject(cfg, 'config', ['strategy', 'strategies', 'retention', 'storage', 'providers', 'models', 'logging', 'integration']);
  const strategies = configObject(cfg.strategies, 'strategies', Object.keys(STRATEGIES));
  configObject(cfg.retention, 'retention', ['scorer']);
  configObject(cfg.storage, 'storage', ['path', 'retentionDays', 'maxSizeBytes', 'blobThresholdBytes']);
  configObject(cfg.providers, 'providers', ['retention', 'capsule', 'chain']);
  configObject(cfg.models, 'models', ['cheapModel']);
  configObject(cfg.logging, 'logging', ['level', 'dir']);
  configObject(cfg.integration, 'integration', ['contextWindow', 'maxOutputChars', 'minSavingsChars', 'captureOnly', 'ingressCompression', 'minHistorySavingsChars', 'historyCooldownTurns', 'rtkDatabasePath']);
  if (!['balanced', 'conservative', 'aggressive'].includes(cfg.strategy)) throw new Error('strategy must be balanced, conservative, or aggressive');
  for (const [name, preset] of Object.entries(strategies)) {
    const p = configObject(preset, `strategies.${name}`, ['trigger', 'release', 'keepThreshold', 'evictThreshold', 'minProtectionTurns']);
    for (const k of ['trigger', 'release', 'keepThreshold', 'evictThreshold']) {
      const v = p[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) throw new Error(`strategies.${name}.${k} must be in [0,1]`);
    }
    if ((p.release as number) >= (p.trigger as number)) throw new Error(`strategies.${name}.release must be below trigger`);
    if ((p.keepThreshold as number) >= (p.evictThreshold as number)) throw new Error(`strategies.${name}.keepThreshold must be below evictThreshold`);
    integer(p.minProtectionTurns, `strategies.${name}.minProtectionTurns`, 1, 10000);
  }
  if (!['jev', 'systemone', 'conservative'].includes(cfg.retention?.scorer)) throw new Error('retention.scorer must be jev, systemone or conservative');
  const s = object(cfg.storage, 'storage');
  if (typeof s.path !== 'string' || !s.path.trim() || s.path.includes('\0')) throw new Error('storage.path must be a nonempty path');
  integer(s.blobThresholdBytes, 'storage.blobThresholdBytes', 0, 64 * 1024 * 1024);
  for (const k of ['retentionDays', 'maxSizeBytes']) if (s[k] !== null) integer(s[k], `storage.${k}`, 0, Number.MAX_SAFE_INTEGER);
  for (const purpose of ['retention', 'capsule', 'chain'] as const) {
    const entries = cfg.providers?.[purpose];
    if (!Array.isArray(entries) || entries.length > 8) throw new Error(`providers.${purpose} must be an array (at most 8)`);
    entries.forEach((entry: ProviderConfig) => {
      configObject(entry, 'provider', ['kind', 'name', 'model'], ['apiKey', 'apiKeyEnv', 'baseUrl', 'reasoningEffort']);
      if (!['openai-compatible', 'anthropic', 'gemini', 'systemone', 'fake'].includes(entry.kind)) throw new Error('unsupported provider kind');
      if (entry.kind === 'systemone') {
        if (purpose !== 'retention' || cfg.retention.scorer !== 'systemone') throw new Error('systemone providers require retention.scorer=systemone and are retention-only');
        if (!entry.baseUrl) throw new Error('systemone provider requires an explicit baseUrl');
      } else if (purpose === 'retention' && cfg.retention.scorer === 'systemone') {
        throw new Error('systemone scorer requires native systemone providers');
      }
      if (!entry.name || !entry.model || typeof entry.name !== 'string' || typeof entry.model !== 'string') throw new Error('provider name/model are required');
      for(const key of ['apiKey','apiKeyEnv','baseUrl'] as const)if(entry[key]!==undefined && typeof entry[key]!=='string')throw new Error(`provider.${key} must be a string`);
      if(entry.apiKeyEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.apiKeyEnv))throw new Error('Invalid API key environment variable');
      if (entry.reasoningEffort !== undefined && (entry.kind !== 'openai-compatible' ||
        !['none', 'low', 'medium', 'high', 'max'].includes(entry.reasoningEffort))) {
        throw new Error('provider.reasoningEffort requires an openai-compatible provider and a supported effort');
      }
      if (entry.baseUrl) {
        const url = new URL(entry.baseUrl);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('provider baseUrl must be HTTP(S), without embedded credentials');
        const old = previous?.providers?.[purpose]?.find(p => p.name === entry.name);
        if (previous !== undefined && !(old && SAME_ENTRY.every(k => old[k] === entry[k])) && cleartextRemote(entry.baseUrl) && (entry.apiKey || entry.apiKeyEnv))
          throw new Error(`provider ${entry.name}: a credential requires an https baseUrl (plain http is only allowed for localhost, 127.0.0.0/8 or [::1])`);
      }
    });
  }
  if (cfg.models.cheapModel !== null && typeof cfg.models.cheapModel !== 'string') throw new Error('models.cheapModel must be a string or null');
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
    try { disk = object(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')), 'config'); }
    catch (error) { throw new Error(`Cannot read ${file}; configuration was not reset. ${errorMessage(error)}`); }
  }
  const merged = merge(merge(base as unknown as Record<string, unknown>, disk), overrides ?? {}) as unknown as Config;
  merged.storage.path = base.storage.path;
  return validateConfig(merged);
}
export function saveConfig(cfg: Config): void {
  validateConfig(cfg);
  const file = path.join(cfg.storage.path, 'config.json');
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600;
  atomicWrite(file, JSON.stringify(cfg, null, 2) + '\n', mode);
}
/** Byte revision of the selected storage's config; never includes a credential. */
export function configRevision(storage: string): string {
  const file = path.join(path.resolve(storage), 'config.json');
  return createHash('sha256').update(fs.existsSync(file) ? fs.readFileSync(file) : Buffer.from('missing')).digest('hex');
}
export class ConfigConflictError extends Error {
  readonly code = 'CONFIG_CONFLICT';
  readonly status = 409;
  constructor() { super('Configuration changed; reload settings before saving.'); this.name = 'ConfigConflictError'; }
}
/** The save is durable but the writer lock stayed behind; the message is static so it is safe to show in a browser. */
export class ConfigLockLeftError extends Error {
  readonly code = 'CONFIG_LOCK_LEFT';
  constructor(readonly config: Config) {
    super('Settings were saved, but the configuration writer lock could not be removed. Close other CMM processes, then delete config.write.lock in the storage folder.');
    this.name = 'ConfigLockLeftError';
  }
}
// Windows reports a lock that is delete-pending or briefly scanned as EPERM/EBUSY/EACCES, not EEXIST.
const BUSY = new Set(['EEXIST', 'EPERM', 'EBUSY', 'EACCES']);
const codeOf = (error: unknown) => (error as NodeJS.ErrnoException).code ?? '';
function readLock(lock: string): string | null { try { return fs.readFileSync(lock, 'utf8'); } catch { return null; } }
/** True only when the recorded holder is provably a dead process on this host; everything else is treated as possibly live. */
function deadHolder(content: string | null): boolean {
  if (!content) return false;
  try {
    const holder = JSON.parse(content) as { pid?: unknown; hostname?: unknown };
    if (!Number.isInteger(holder.pid) || (holder.pid as number) <= 0 || holder.hostname !== os.hostname()) return false;
    try { process.kill(holder.pid as number, 0); return false; }
    catch (error) { return codeOf(error) === 'ESRCH'; }
  } catch { return false; }
}
const GUARD_STALE_MS = 10_000;
/**
 * Reclaims serialize on a guard held for microseconds, so the lock cannot be replaced between the re-read and the
 * unlink: a live writer's lock never carries `seen`. An abandoned guard is removed once old; the next attempt retries.
 */
function removeStaleLock(lock: string, seen: string): void {
  const guard = `${lock}.reclaim`;
  let fd: number;
  try { fd = fs.openSync(guard, 'wx', 0o600); }
  catch (error) {
    if (BUSY.has(codeOf(error))) { try { if (Date.now() - fs.statSync(guard).mtimeMs > GUARD_STALE_MS) fs.unlinkSync(guard); } catch { /* gone or busy */ } }
    return;
  }
  try { if (readLock(lock) === seen && deadHolder(seen)) fs.unlinkSync(lock); }
  catch { /* retried by the next writer */ }
  finally {
    try { fs.closeSync(fd); } catch { /* best effort */ }
    try { fs.unlinkSync(guard); } catch { /* aged out by the next reclaimer */ }
  }
}
/** Only the lock this process wrote is removed; one now owned by another writer is left alone. `partial` covers a failed write of our own content. */
async function releaseLock(fd: number, lock: string, owned: string, partial: boolean): Promise<void> {
  try { fs.closeSync(fd); } catch { /* unlink below is what matters */ }
  const deadline = Date.now() + 2000;
  for (let wait = 5; ; wait = Math.min(wait * 2, 100)) {
    try {
      const now = fs.readFileSync(lock, 'utf8');
      if (now === owned || (partial && owned.startsWith(now))) fs.unlinkSync(lock);
      return;
    }
    catch (error) {
      if (codeOf(error) === 'ENOENT') return;
      if (!BUSY.has(codeOf(error)) || Date.now() >= deadline) throw error;
      await delay(wait);
    }
  }
}
/** All interactive writers use this lock and reread. A lock is only removed automatically when its recorded holder is a dead process on this host. */
export async function updateConfig(storage: string,
  patch: Record<string, unknown> | ((current: Config) => Record<string, unknown>), expectedRevision?: string, timeoutMs = 10000): Promise<Config> {
  const root = path.resolve(storage);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const lock = path.join(root, 'config.write.lock');
  const deadline = Date.now() + timeoutMs;
  let fd: number;
  for (let wait = 5;;) {
    try { fd = fs.openSync(lock, 'wx', 0o600); break; }
    catch (error) {
      if (!BUSY.has(codeOf(error))) throw error;
      const seen = readLock(lock);
      if (seen !== null && deadHolder(seen)) removeStaleLock(lock, seen);
      if (Date.now() >= deadline) {
        if (codeOf(error) !== 'EEXIST' && seen === null) throw error;
        throw new Error(`Configuration writer lock ${lock} is held${seen ? ` (${seen.trim().slice(0, 200)})` : ''}; no settings were changed. ` +
          'Delete that file only if no Context Memory Manager process is running.');
      }
      await delay(wait); wait = Math.min(wait * 2, 40);
    }
  }
  let failure: unknown, result: Config | undefined, failed = false, written = false;
  const owned = JSON.stringify({ pid: process.pid, hostname: os.hostname(), createdAt: new Date().toISOString() });
  try {
    fs.writeFileSync(fd, owned); written = true;
    const file = path.join(root, 'config.json');
    if (expectedRevision !== undefined && expectedRevision !== configRevision(root)) throw new ConfigConflictError();
    const compute = () => {
      const current = loadConfig(root);
      const change = typeof patch === 'function' ? patch(structuredClone(current)) : patch;
      if (change.storage && Object.hasOwn(object(change.storage, 'storage'), 'path') &&
          (typeof patch !== 'function' || object(change.storage, 'storage').path !== current.storage.path)) throw new Error('storage.path cannot be changed');
      const fields = object(change, 'patch');
      // CLI callbacks may return a complete edited config. Preserve replacement
      // validation in that case; merging would silently repair missing fields.
      const completeReplacement = typeof patch === 'function' && Object.keys(current).every(key => Object.hasOwn(fields,key));
      return validateConfig((completeReplacement ? fields : merge(current as unknown as Record<string, unknown>, fields)) as unknown as Config, current);
    };
    if (!fs.existsSync(file)) {
      compute(); // an invalid patch must not leave a defaults file behind
      // Establish an atomic initial winner before the read-modify-write, so a
      // concurrent ContextManager opener cannot publish defaults after our read.
      createConfigIfAbsent(defaultConfig(root));
    }
    result = compute();
    saveConfig(result);
  } catch (error) { failed = true; failure = error; }
  try { await releaseLock(fd, lock, owned, !written); }
  catch { if (!failed) throw new ConfigLockLeftError(result!); }
  if (failed) throw failure;
  return result!;
}
/** Initial creation never replaces settings published by another opener. */
export function createConfigIfAbsent(cfg: Config): boolean {
  validateConfig(cfg, null);
  return atomicCreate(path.join(cfg.storage.path, 'config.json'), JSON.stringify(cfg, null, 2) + '\n');
}
export function activePreset(cfg: Config): StrategyPreset { return cfg.strategies[cfg.strategy]; }
export function redactConfig(cfg: Config): Record<string, unknown> {
  return JSON.parse(JSON.stringify(cfg, (key, value: unknown) => /^(apiKey|authorization|password|token|secret)$/i.test(key) && value ? '[REDACTED]' : value));
}
