/**
 * User-ordered provider failover (PRD §10).
 *
 * Tries providers in the user's configured order. Every attempt — success
 * or failure — is recorded via recordCall so provider usage and cost stay
 * auditable. Total failure throws; the caller then falls back to the
 * conservative deterministic scorer (KEEP unless extremely safe).
 */

import type {
  CompletionRequest,
  CompletionResponse,
  Logger,
  ModelProvider,
  ProviderCallRecord,
} from '../types.js';
import { ProviderError, type AbortableRequest } from './provider.js';
import { errorMessage } from '../util/validation.js';
import { redact } from '../logging.js';

export type ProviderAttemptObserver = (attempt: {purpose: 'retention'|'capsule'|'chain';provider: string}) =>
  ((result: {status: 'ok'|'error'; model?: string}) => void);
// Weak keys keep observers local to their configured provider instances. No
// process-global current manager, storage, request text or credentials are held.
const observers = new WeakMap<ModelProvider,ProviderAttemptObserver>();
export function observeProvider(provider: ModelProvider, observer: ProviderAttemptObserver): void { observers.set(provider,observer); }

/**
 * Overall wall-clock budget across all providers of one call. Retention scoring is awaited on the host
 * request path, so it gets the tightest bound; per-attempt timeouts alone would multiply by the provider count.
 */
export const FAILOVER_DEADLINE_MS = Object.freeze({ retention: 20_000, capsule: 45_000, chain: 20_000 });

function whenAborted(signal: AbortSignal): { promise: Promise<never>; release(): void } {
  let onAbort: () => void = () => {};
  const promise = new Promise<never>((_, reject) => {
    onAbort = () => reject(new ProviderError('overall provider deadline exceeded or cancelled'));
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
  });
  promise.catch(() => {});
  return { promise, release: () => signal.removeEventListener('abort', onAbort) };
}

export async function completeWithFailover(
  providers: ModelProvider[],
  req: CompletionRequest,
  opts: {
    purpose: 'retention' | 'capsule' | 'chain';
    recordCall: (r: ProviderCallRecord) => void;
    logger: Logger;
    validate?: (response: CompletionResponse) => void;
    observe?: ProviderAttemptObserver;
    /** Overall budget across providers; defaults per purpose (FAILOVER_DEADLINE_MS). */
    deadlineMs?: number;
  },
): Promise<CompletionResponse> {
  if (providers.length === 0) {
    throw new ProviderError('no providers configured');
  }
  const { purpose, recordCall, logger } = opts;
  let lastError: unknown = null;
  const budget = opts.deadlineMs ?? FAILOVER_DEADLINE_MS[purpose];
  const endsAt = Date.now() + budget;
  const deadline = AbortSignal.timeout(budget);
  const caller = (req as AbortableRequest).signal;
  const signal = caller ? AbortSignal.any([deadline, caller]) : deadline;

  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    if (signal.aborted) { lastError = new ProviderError('overall provider deadline exceeded or cancelled'); break; }
    // A stalled provider may use only its share of what is left, so later providers still get a turn.
    const share = Math.max(1, Math.floor((endsAt - Date.now()) / (providers.length - i)));
    const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.min(req.timeoutMs && req.timeoutMs > 0 ? req.timeoutMs : Infinity, share))]);
    let received: CompletionResponse | undefined;
    let attemptOk = false;
    let end: ReturnType<ProviderAttemptObserver> | undefined;
    try { end=(opts.observe ?? observers.get(p))?.({purpose,provider:p.name}); } catch { /* Diagnostics never affect failover. */ }
    try {
      // Providers get the attempt signal to abort real I/O; the race also bounds providers that ignore it.
      const attempt: AbortableRequest = { ...req, signal: attemptSignal };
      const aborted = whenAborted(attemptSignal);
      let res: CompletionResponse;
      try { res = received = await Promise.race([p.complete(attempt), aborted.promise]); } finally { aborted.release(); }
      opts.validate?.(res);
      recordCall({
        provider: p.name,
        model: res.model,
        purpose,
        tokensIn: res.tokensIn,
        tokensOut: res.tokensOut,
        costUsd: 0, // Unpriced, not zero-cost. No guessed provider tariffs.
        ok: true,
      });
      if (i > 0) logger.log('provider switched', { purpose, to: p.name });
      attemptOk = true;
      return res;
    } catch (e) {
      recordCall({
        provider: p.name,
        model: received?.model ?? 'unknown',
        purpose,
        tokensIn: received?.tokensIn ?? 0,
        tokensOut: received?.tokensOut ?? 0,
        costUsd: 0,
        ok: false,
        error: String(redact(errorMessage(e))),
      });
      logger.log('provider failed', {
        purpose,
        provider: p.name,
        error: String(redact(errorMessage(e))),
      });
      lastError = e;
    } finally {
      try { end?.({status:attemptOk?'ok':'error',model:received?.model}); } catch { /* fail-open */ }
    }
  }

  throw new ProviderError(
    `all ${providers.length} providers failed: ${String(redact(errorMessage(lastError)))}`,
  );
}
