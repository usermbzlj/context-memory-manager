import type { Config, ProviderConfig } from '../types.js';
import { configRevision, updateConfig } from '../config.js';
import { loadConfig } from '../config.js';
import { createHash } from 'node:crypto';
import { object } from '../util/validation.js';

const roles = ['retention', 'capsule', 'chain'] as const;
function displayUrl(value:string|undefined) {
  if (!value) return undefined;
  const u=new URL(value);u.search='';u.hash='';u.username='';u.password='';return u.toString();
}
export function publicSettings(cfg: Config, storage: string, revision = configRevision(storage)) {
  return { revision, strategy: cfg.strategy, strategies: cfg.strategies,
    retention: cfg.retention, storage: cfg.storage, logging: cfg.logging, integration: cfg.integration, models: cfg.models,
    scope: 'storage-global', providers: Object.fromEntries(roles.map(role => [role, cfg.providers[role].map(p => {
      const baseUrl=displayUrl(p.baseUrl);
      return {kind:p.kind,name:p.name,model:p.model,baseUrl,reasoningEffort:p.reasoningEffort,apiKeyEnv:p.apiKeyEnv,
        keyConfigured:Boolean(p.apiKey || (p.apiKeyEnv && process.env[p.apiKeyEnv])),
        keySource:p.apiKey ? 'stored' : p.apiKeyEnv ? 'environment' : 'none'};
    })])), adoption: {saved:true,adopted:false,otherHostsRequireReload:true} };
}
/** A concurrent file publication must never pair stale settings with a newer CAS revision. */
export function readSettings(storage: string) {
  for (let attempt=0;attempt<5;attempt++) {
    const revision=configRevision(storage),cfg=loadConfig(storage);
    if (revision===configRevision(storage)) return publicSettings(cfg,storage,revision);
  }
  throw new Error('Configuration is changing; reload settings.');
}
function keys(value: Record<string, unknown>, allowed: readonly string[]) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error('Invalid settings field');
}
export async function saveSettings(storage: string, expectedRevision: string, value: unknown) {
  const patch = object(value, 'patch');
  keys(patch,['strategy','strategies','retention','storage','logging','integration','models','providers']);
  if (patch.storage) keys(object(patch.storage,'storage'),['retentionDays','maxSizeBytes','blobThresholdBytes']);
  // Paths are startup choices, never arbitrary file operations through the browser.
  if (patch.logging) keys(object(patch.logging,'logging'),['level']);
  if (patch.integration) keys(object(patch.integration,'integration'),['contextWindow','maxOutputChars','minSavingsChars','captureOnly','ingressCompression','minHistorySavingsChars','historyCooldownTurns']);
  const cfg = await updateConfig(storage, current => {
    const merged = structuredClone(patch);
    if (patch.providers !== undefined) {
      const providers = object(patch.providers,'providers'); keys(providers,roles);
      const replacement: Record<string, ProviderConfig[]> = {};
      for (const role of roles) if (Object.hasOwn(providers,role)) {
        const entries = providers[role];
        if (!Array.isArray(entries) || entries.length > 8) throw new Error('Invalid provider list');
        const names = new Set<string>();
        replacement[role] = entries.map(value => {
          const entry = object(value,'provider');
          keys(entry,['kind','name','model','baseUrl','reasoningEffort','apiKeyEnv','keyAction','newKey']);
          if (typeof entry.name !== 'string' || names.has(entry.name)) throw new Error('Provider names must be unique');
          names.add(entry.name);
          const old = current.providers[role].find(p => p.name === entry.name);
          const action = entry.keyAction ?? 'keep';
          if (!['keep','replace','delete'].includes(String(action))) throw new Error('Invalid key action');
          if (entry.newKey !== undefined && action !== 'replace') throw new Error('New key requires replace action');
          const p = Object.fromEntries(Object.entries(entry).filter(([k]) => k !== 'keyAction' && k !== 'newKey')) as unknown as ProviderConfig;
          if (p.baseUrl) { const u = new URL(p.baseUrl); if (u.username || u.password || u.search || u.hash) throw new Error('Provider URLs cannot contain credentials, query or fragment'); }
          // The DTO hides the stored query/fragment/userinfo, so an edit that keeps origin and path keeps them, whatever else changed.
          if (old?.baseUrl && p.baseUrl && new URL(p.baseUrl).toString() === displayUrl(old.baseUrl)) p.baseUrl = old.baseUrl;
          if (action === 'keep' && old?.apiKey !== undefined) {
            const origin = (url?: string) => url ? new URL(url).origin : '';
            if (origin(p.baseUrl) !== origin(old.baseUrl))
              throw new Error(`Provider ${entry.name}: the base URL origin changed, so the stored API key cannot be kept. Re-enter the key (replace) or delete it.`);
            p.apiKey = old.apiKey;
          }
          if (action === 'replace') {
            if (typeof entry.newKey !== 'string' || !entry.newKey.trim() || entry.newKey.trim() === '[REDACTED]' || entry.newKey.length > 8192) throw new Error('Invalid replacement key');
            p.apiKey = entry.newKey;
          }
          // keyAction edits only the write-only literal key; the environment
          // reference is a separate editable field (empty string clears it).
          if (!Object.hasOwn(entry,'apiKeyEnv') && old?.apiKeyEnv) p.apiKeyEnv = old.apiKeyEnv;
          return p;
        });
      }
      merged.providers = replacement;
    }
    return merged;
  }, expectedRevision);
  const revision=createHash('sha256').update(JSON.stringify(cfg,null,2)+'\n').digest('hex');
  return {...publicSettings(cfg,storage,revision),saved:true,adopted:false,reloadRequired:true};
}
