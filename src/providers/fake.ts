/**
 * Fake provider for tests and demos. Returns canned text; can be told to
 * fail a number of times first to exercise failover paths.
 */

import type {
  CompletionRequest,
  CompletionResponse,
  ModelProvider,
} from '../types.js';
import { ProviderError } from './provider.js';

export class FakeProvider implements ModelProvider {
  readonly name: string;
  private failTimes: number;

  constructor(
    name: string,
    private readonly text: string,
    private readonly opts: {
      tokensIn?: number;
      tokensOut?: number;
      failTimes?: number;
    } = {},
  ) {
    this.name = name;
    this.failTimes = opts.failTimes ?? 0;
  }

  async complete(_req: CompletionRequest): Promise<CompletionResponse> {
    if (this.failTimes > 0) {
      this.failTimes -= 1;
      throw new ProviderError(`${this.name}: injected failure`);
    }
    return {
      text: this.text,
      tokensIn: this.opts.tokensIn ?? 10,
      tokensOut: this.opts.tokensOut ?? 5,
      model: 'fake',
    };
  }
}
