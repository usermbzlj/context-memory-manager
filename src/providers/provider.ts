/**
 * Provider base: error type shared by all providers. Pricing is deliberately
 * unconfigured; provider-reported token counts remain in the call ledger.
 */

/** Thrown for provider-side problems: missing key, HTTP error, bad payload. */
export class ProviderError extends Error {
  constructor(message: string, opts?: { cause?: unknown }) {
    super(message, opts as ErrorOptions);
    this.name = 'ProviderError';
  }
}
