/** Native decision transport. The internal text field carries JSON, not generated prose. */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { CompletionRequest, CompletionResponse, ModelProvider, ProviderConfig } from '../types.js';
import { ProviderError, requestSignal } from './provider.js';
import { cleartextRemote } from '../config.js';

const MAX_NATIVE_RESPONSE_BYTES = 256 * 1024;

export class SystemOneProvider implements ModelProvider {
  readonly name: string;
  constructor(private readonly cfg: ProviderConfig) { this.name = cfg.name; }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    if (!this.cfg.baseUrl) throw new ProviderError(`${this.name}: explicit baseUrl required`);
    const url = new URL(`${this.cfg.baseUrl.replace(/\/$/, '')}/systemone`);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    const key = this.cfg.apiKey ?? (this.cfg.apiKeyEnv ? process.env[this.cfg.apiKeyEnv] : undefined);
    if (!key && !local) throw new ProviderError(`${this.name}: no API key (keyless access requires loopback)`);
    if (key && cleartextRemote(url.href)) throw new ProviderError(`${this.name}: credential refused over plain http to a non-loopback host`);
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(req.user); }
    catch { throw new ProviderError(`${this.name}: invalid native decision request`); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        !Object.hasOwn(payload, 'state') || !payload.questions || typeof payload.questions !== 'object' || Array.isArray(payload.questions)) {
      throw new ProviderError(`${this.name}: expected state and questions`);
    }
    const body = JSON.stringify({ ...payload, model: this.cfg.model });
    const signal = requestSignal(req);
    // `agent: false` uses a fresh, proxy-less agent. Node 24 routes the default global agent (and fetch)
    // through HTTP_PROXY/HTTPS_PROXY when NODE_USE_ENV_PROXY=1 or --use-env-proxy is set, even for
    // loopback; archive-derived decision requests must reach the configured endpoint directly.
    // Redirects are never followed (a non-200 status is a failure) so the prompt cannot change host.
    const text = await new Promise<string>((resolve, reject) => {
      const fail = (message: string) => reject(new ProviderError(`${this.name}: ${message}`));
      const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const call = send(url, { method: 'POST', agent: false, signal, headers: {
        'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      } }, response => {
        const status = response.statusCode ?? 0;
        if (status !== 200) {
          response.destroy();
          fail(status >= 300 && status < 400 ? `redirect refused (HTTP ${status})` : `HTTP ${status} (response body omitted)`);
          return;
        }
        if (Number(response.headers['content-length']) > MAX_NATIVE_RESPONSE_BYTES) {
          response.destroy(); fail('response exceeds size limit'); return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0, complete = false;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_NATIVE_RESPONSE_BYTES) { response.destroy(); fail('response exceeds size limit'); }
          else chunks.push(chunk);
        });
        response.on('end', () => { complete = true; resolve(Buffer.concat(chunks).toString('utf8')); });
        // An abort or reset after the headers (stalled/truncated body) surfaces as error and/or close.
        response.on('error', () => fail(signal.aborted ? 'decision request timed out or was cancelled' : 'decision response interrupted'));
        response.on('close', () => { if (!complete) fail(signal.aborted ? 'decision request timed out or was cancelled' : 'decision response interrupted'); });
      });
      call.on('error', () => fail(signal.aborted ? 'decision request timed out or was cancelled' : 'decision request failed'));
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
  }
}
