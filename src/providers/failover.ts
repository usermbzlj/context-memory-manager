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
import { ProviderError } from './provider.js';
import { errorMessage } from '../util/validation.js';
import { redact } from '../logging.js';

export async function completeWithFailover(
  providers: ModelProvider[],
  req: CompletionRequest,
  opts: {
    purpose: 'retention' | 'capsule' | 'chain';
    recordCall: (r: ProviderCallRecord) => void;
    logger: Logger;
    validate?: (response: CompletionResponse) => void;
  },
): Promise<CompletionResponse> {
  if (providers.length === 0) {
    throw new ProviderError('no providers configured');
  }
  const { purpose, recordCall, logger } = opts;
  let lastError: unknown = null;

  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    let received: CompletionResponse | undefined;
    try {
      const res = received = await p.complete(req);
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
    }
  }

  throw new ProviderError(
    `all ${providers.length} providers failed: ${String(redact(errorMessage(lastError)))}`,
  );
}
