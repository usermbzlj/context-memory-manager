/**
 * Native Anthropic provider (Anthropic Messages API).
 */

import type {
  CompletionRequest,
  CompletionResponse,
  ModelProvider,
  ProviderConfig,
} from '../types.js';
import { ProviderError } from './provider.js';

export class AnthropicProvider implements ModelProvider {
  readonly name: string;
  private readonly cfg: ProviderConfig;

  constructor(cfg: ProviderConfig) {
    this.cfg = cfg;
    this.name = cfg.name;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const apiKey =
      this.cfg.apiKey ??
      (this.cfg.apiKeyEnv ? process.env[this.cfg.apiKeyEnv] : undefined);
    if (!apiKey) throw new ProviderError(`${this.name}: no API key`);

    const url = `${(this.cfg.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      req.timeoutMs ?? 30000,
    );
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.cfg.model,
          max_tokens: req.maxTokens ?? 1024,
          ...(req.system ? { system: req.system } : {}),
          messages: [{ role: 'user', content: req.user }],
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        // Error bodies can echo prompts and credentials. Keep only the status.
        await res.body?.cancel().catch(() => {});
        throw new ProviderError(`${this.name}: HTTP ${res.status} (response body omitted)`);
      }
      const data = (await res.json()) as {
        content?: Array<{ type?: string; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const text = (data.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('');
      return {
        text,
        tokensIn: data.usage?.input_tokens ?? 0,
        tokensOut: data.usage?.output_tokens ?? 0,
        model: this.cfg.model,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
