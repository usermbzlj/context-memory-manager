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
export const errorText = (error: unknown) => error instanceof ApiError ? `${error.message} (${error.code})` : error instanceof Error ? error.message : '发生未知错误';
export function downloadUrl(scopeId: string, eventId: string, field: string) { return '/api/download?' + new URLSearchParams({scopeId,eventId,field}); }
