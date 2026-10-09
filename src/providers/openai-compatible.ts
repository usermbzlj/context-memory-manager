/**
 * OpenAI-compatible provider (OpenAI, and any /v1 chat-completions API).
 */

import type {
  CompletionRequest,
  CompletionResponse,
  ModelProvider,
  ProviderConfig,
} from '../types.js';
import { ProviderError, postJson } from './provider.js';

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
    const data = (await postJson(this.name, url, {
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? {authorization: `Bearer ${apiKey}`} : {}),
      },
      body: JSON.stringify({
        model: this.cfg.model,
        ...(this.cfg.reasoningEffort !== undefined ? { reasoning_effort: this.cfg.reasoningEffort } : {}),
        messages: [
          ...(req.system ? [{ role: 'system', content: req.system }] : []),
          { role: 'user', content: req.user },
        ],
        ...(req.jsonMode ? { response_format: { type: 'json_object' } } : {}),
        ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
      }),
      request: req,
    })) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    } | null;
    const text = data?.choices?.[0]?.message?.content ?? '';
    return {
      text,
      tokensIn: data?.usage?.prompt_tokens ?? 0,
      tokensOut: data?.usage?.completion_tokens ?? 0,
      model: this.cfg.model,
    };
  }
}
