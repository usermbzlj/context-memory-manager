/**
 * OpenAI-compatible provider (OpenAI, and any /v1 chat-completions API).
 */

import type {
  CompletionRequest,
  CompletionResponse,
  ModelProvider,
  ProviderConfig,
} from '../types.js';
import { ProviderError } from './provider.js';

export class OpenAICompatibleProvider implements ModelProvider {
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
    const url = `${(this.cfg.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')}/chat/completions`;
    const local=['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname);
    if(!apiKey && !local)throw new ProviderError(`${this.name}: no API key (keyless access is restricted to explicit loopback endpoints)`);
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
          ...(apiKey ? {authorization: `Bearer ${apiKey}`} : {}),
        },
        body: JSON.stringify({
          model: this.cfg.model,
          messages: [
            ...(req.system ? [{ role: 'system', content: req.system }] : []),
            { role: 'user', content: req.user },
          ],
          ...(req.jsonMode ? { response_format: { type: 'json_object' } } : {}),
          ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        // Error bodies can echo prompts and credentials. Keep only the status.
        await res.body?.cancel().catch(() => {});
        throw new ProviderError(`${this.name}: HTTP ${res.status} (response body omitted)`);
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = data.choices?.[0]?.message?.content ?? '';
      return {
        text,
        tokensIn: data.usage?.prompt_tokens ?? 0,
        tokensOut: data.usage?.completion_tokens ?? 0,
        model: this.cfg.model,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
