/**
 * Provider base: error type shared by all providers. Pricing is deliberately
 * unconfigured; provider-reported token counts remain in the call ledger.
 */

import type { CompletionRequest } from '../types.js';
import { cleartextRemote } from '../config.js';

/** Thrown for provider-side problems: missing key, HTTP error, bad payload. */
export class ProviderError extends Error {
  constructor(message: string, opts?: { cause?: unknown }) {
    super(message, opts as ErrorOptions);
    this.name = 'ProviderError';
  }
}

/** Providers never buffer more than this from a model endpoint. */
export const MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * Callers may attach a cancellation signal (e.g. an overall batch deadline) to
 * any request; providers abort in-flight HTTP work when it fires.
 */
export type AbortableRequest = CompletionRequest & { signal?: AbortSignal };

/** Per-attempt timeout combined with the caller's overall signal, if any. */
export function requestSignal(req: CompletionRequest, defaultMs = 30000): AbortSignal {
  const timeout = AbortSignal.timeout(req.timeoutMs ?? defaultMs);
  const outer = (req as AbortableRequest).signal;
  return outer ? AbortSignal.any([timeout, outer]) : timeout;
}

/** Only fixed text: transport errors can echo URLs, headers or bodies. */
function transportError(name: string, error: unknown, signal: AbortSignal): ProviderError {
  if (error instanceof ProviderError) return error;
  if (signal.aborted) return new ProviderError(`${name}: request timed out or was cancelled`);
  const cause = (error as { cause?: { message?: unknown } } | undefined)?.cause;
  if (/redirect/i.test(String(cause?.message ?? ''))) return new ProviderError(`${name}: redirect refused`);
  return new ProviderError(`${name}: request failed`);
}

async function readCapped(name: string, res: Response, signal: AbortSignal): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (declared > MAX_RESPONSE_BYTES) {
    await res.body?.cancel().catch(() => {});
    throw new ProviderError(`${name}: response exceeds size limit`);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const reader = res.body?.getReader();
    for (;;) {
      const next = await reader?.read();
      if (!reader || !next || next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new ProviderError(`${name}: response exceeds size limit`);
      }
      chunks.push(next.value);
    }
  } catch (error) { throw transportError(name, error, signal); }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * POST JSON and parse a bounded JSON reply. Redirects are refused (the body is
 * archive-derived and the headers may carry credentials), the response is
 * capped, and no response body ever reaches an error message.
 */
export async function postJson(name: string, url: string,
  init: { headers: Record<string, string>; body: string; signal: AbortSignal }): Promise<unknown> {
  const credentialed = Object.keys(init.headers).some(h => /^(authorization|x-api-key)$/i.test(h)) || new URL(url).searchParams.has('key');
  if (credentialed && cleartextRemote(url)) throw new ProviderError(`${name}: credential refused over plain http to a non-loopback host`);
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: init.headers, body: init.body, redirect: 'error', signal: init.signal });
  } catch (error) { throw transportError(name, error, init.signal); }
  if (!res.ok) {
    // Error bodies can echo prompts and credentials. Keep only the status.
    await res.body?.cancel().catch(() => {});
    throw new ProviderError(`${name}: HTTP ${res.status} (response body omitted)`);
  }
  const text = await readCapped(name, res, init.signal);
  try { return JSON.parse(text); }
  catch { throw new ProviderError(`${name}: invalid response JSON (body omitted)`); }
}
