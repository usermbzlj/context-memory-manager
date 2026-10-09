export type Data = Record<string, any>;
let csrfToken = '';
export class ApiError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
async function decode(response: Response): Promise<any> {
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.error) throw new ApiError(body?.error?.code ?? `HTTP_${response.status}`, body?.error?.message ?? '本地服务暂时无法响应。请检查服务后重试。');
  return body?.result ?? body;
}
export interface ScopePreference {agent?:string;workspaceId?:string}
export async function authenticate(): Promise<ScopePreference | undefined> {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const token = fragment.get('token');
  if (token) {
    history.replaceState(null, '', location.pathname + location.search);
    await decode(await fetch('/api/session', {method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'}, body:JSON.stringify({token})}));
  }
  const session = await decode(await fetch('/api/session', {credentials:'same-origin', cache:'no-store'}));
  csrfToken = session.csrfToken;
  if (!csrfToken) throw new ApiError('SESSION_INVALID', '浏览器会话无效，请使用终端中的面板引导链接。');
  return session.preference;
}
export async function command<T = Data>(method: string, params: Data = {}): Promise<T> {
  return decode(await fetch('/api/command', {method:'POST', credentials:'same-origin', cache:'no-store', headers:{'Content-Type':'application/json','X-CMM-CSRF':csrfToken}, body:JSON.stringify({method,params})}));
}
// Settings validation detail comes from the configuration validator, which reports in English.
const prefixes: Record<string, string> = {INVALID_SETTINGS: '设置未保存，校验未通过：', INVALID_REQUEST: '请求无效：'};
export const errorText = (error: unknown) => error instanceof ApiError ? `${prefixes[error.code] ?? ''}${error.message} (${error.code})` : error instanceof Error ? error.message : '发生未知错误';
/** Server-side cap; a larger known size is explained in the UI instead of attempting the request. */
export const DOWNLOAD_LIMIT = 32 * 1024 * 1024;
const hex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
/** Fetches the exact original as a blob with the session cookie; failures stay inside the SPA as ApiError. */
export async function download(scopeId: string, eventId: string, field: string): Promise<{blob: Blob; filename: string}> {
  const response = await fetch('/api/download?' + new URLSearchParams({scopeId,eventId,field}), {credentials:'same-origin', cache:'no-store'});
  if (!response.ok) await decode(response);
  const bytes = await response.arrayBuffer();
  const expected = response.headers.get('x-content-sha256');
  // The server already verified the archive hash; this catches transit/proxy damage. subtle is unavailable outside secure contexts.
  if (expected && globalThis.crypto?.subtle && hex(await crypto.subtle.digest('SHA-256', bytes)) !== expected)
    throw new ApiError('HASH_MISMATCH', '下载内容的 SHA-256 与服务端不一致，已放弃保存。');
  const filename = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') ?? '')?.[1] ?? `${eventId}-${field}.txt`;
  return {blob: new Blob([bytes], {type:'text/plain;charset=utf-8'}), filename};
}
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = filename; link.rel = 'noopener'; link.hidden = true;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
