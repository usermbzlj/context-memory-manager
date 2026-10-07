/**
 * Build the configured provider instances in user order.
 */

import type { ModelProvider, ProviderConfig } from '../types.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';
import { AnthropicProvider } from './anthropic.js';
import { GeminiProvider } from './gemini.js';
import { FakeProvider } from './fake.js';

export function buildProviders(configs: ProviderConfig[]): ModelProvider[] {
  return configs.map((cfg) => {
    switch (cfg.kind) {
      case 'openai-compatible':
        return new OpenAICompatibleProvider(cfg);
      case 'anthropic':
        return new AnthropicProvider(cfg);
      case 'gemini':
        return new GeminiProvider(cfg);
      case 'fake':
        return new FakeProvider(cfg.name, '{"safeToEvict":0.5}');
      default: {
        const unknownKind = (cfg as { kind?: string }).kind;
        throw new Error(`unknown provider kind: ${unknownKind}`);
      }
    }
  });
}
