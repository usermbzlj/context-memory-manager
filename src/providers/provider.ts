/**
 * Provider base: error type and cost estimation shared by all providers.
 */

/** Thrown for provider-side problems: missing key, HTTP error, bad payload. */
export class ProviderError extends Error {
  constructor(message: string, opts?: { cause?: unknown }) {
    super(message, opts as ErrorOptions);
    this.name = 'ProviderError';
  }
}

/**
 * @deprecated Pricing is deliberately unconfigured. Legacy numerical ledgers use 0
 * as an UNPRICED sentinel, not a claim that the request was free. Query the provider
 * billing system for money; provider-reported token counts remain available.
 */
export function estimateCostUsd(_model:string,_tokensIn:number,_tokensOut:number):number {return 0;}
