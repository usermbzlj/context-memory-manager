/** Native decision transport. The internal text field carries JSON, not generated prose. */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { CompletionRequest, CompletionResponse, ModelProvider, ProviderConfig } from '../types.js';
import { ProviderError } from './provider.js';

export class SystemOneProvider implements ModelProvider {
  readonly name: string;
  constructor(private readonly cfg: ProviderConfig) { this.name = cfg.name; }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    if (!this.cfg.baseUrl) throw new ProviderError(`${this.name}: explicit baseUrl required`);
    const url = new URL(`${this.cfg.baseUrl.replace(/\/$/, '')}/systemone`);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    const key = this.cfg.apiKey ?? (this.cfg.apiKeyEnv ? process.env[this.cfg.apiKeyEnv] : undefined);
    if (!key && !local) throw new ProviderError(`${this.name}: no API key (keyless access requires loopback)`);
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(req.user); }
    catch { throw new ProviderError(`${this.name}: invalid native decision request`); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        !Object.hasOwn(payload, 'state') || !payload.questions || typeof payload.questions !== 'object' || Array.isArray(payload.questions)) {
      throw new ProviderError(`${this.name}: expected state and questions`);
    }
    const body = JSON.stringify({ ...payload, model: this.cfg.model });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), req.timeoutMs ?? 30000);
    try {
      // Node's built-in HTTP transport connects directly, including with HTTP_PROXY/ALL_PROXY set.
      // Do not follow redirects: an archive-derived prompt must not silently move to another host.
      const text = await new Promise<string>((resolve, reject) => {
        const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
        const call = send(url, { method: 'POST', signal: controller.signal, headers: {
          'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        } }, response => {
          if (response.statusCode !== 200) {
            response.destroy();
            reject(new ProviderError(`${this.name}: HTTP ${response.statusCode} (response body omitted)`));
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 256 * 1024) {
              response.destroy(new ProviderError(`${this.name}: response exceeds size limit`));
            } else chunks.push(chunk);
          });
          response.on('error', reject);
          response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
        call.on('error', () => reject(new ProviderError(`${this.name}: decision request failed or timed out`)));
        call.end(body);
      });
      let data: { usage?: { input_tokens?: number; output_tokens?: number }; model?: string };
      try { data = JSON.parse(text); }
      catch { throw new ProviderError(`${this.name}: invalid decision JSON (body omitted)`); }
      const tokensIn = data?.usage?.input_tokens;
      const tokensOut = data?.usage?.output_tokens;
      if (!Number.isSafeInteger(tokensIn) || (tokensIn as number) < 0 || tokensOut !== 0) {
        throw new ProviderError(`${this.name}: invalid decision usage`);
      }
      return { text, tokensIn: tokensIn as number, tokensOut: 0, model: typeof data.model === 'string' ? data.model : this.cfg.model };
    } finally { clearTimeout(timeout); }
  }
}
