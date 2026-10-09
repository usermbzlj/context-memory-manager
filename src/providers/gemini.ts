/**
 * Native Gemini provider (generativelanguage.googleapis.com).
 * The API key travels as a `key` query parameter, per Gemini convention.
 */

import type {
  CompletionRequest,
  CompletionResponse,
  ModelProvider,
  ProviderConfig,
} from '../types.js';
import { ProviderError, postJson } from './provider.js';

export class GeminiProvider implements ModelProvider {
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

    const url =
      `${(this.cfg.baseUrl ?? 'https://generativelanguage.googleapis.com').replace(/\/$/, '')}` +
      `/v1beta/models/${encodeURIComponent(this.cfg.model)}:generateContent` +
      `?key=${encodeURIComponent(apiKey)}`;
    const data = (await postJson(this.name, url, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(req.system
          ? { systemInstruction: { parts: [{ text: req.system }] } }
          : {}),
        contents: [{ role: 'user', parts: [{ text: req.user }] }],
        ...(req.jsonMode
          ? { generationConfig: { responseMimeType: 'application/json' } }
          : {}),
      }),
      request: req,
    })) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
      };
    } | null;
    const text =
      data?.candidates?.[0]?.content?.parts
        ?.map((p) => p.text ?? '')
        .join('') ?? '';
    return {
      text,
      tokensIn: data?.usageMetadata?.promptTokenCount ?? 0,
      tokensOut: data?.usageMetadata?.candidatesTokenCount ?? 0,
      model: this.cfg.model,
    };
  }
}
