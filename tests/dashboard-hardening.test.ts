import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDashboard } from '../src/dashboard/server.js';
import { publicFailure, ManagementError } from '../src/management/service.js';
import { ConfigLockLeftError, defaultConfig } from '../src/config.js';
import { makeManager, cleanup, sampleInput } from './util.js';

type Dashboard = Awaited<ReturnType<typeof startDashboard>>;
const portOf = (dashboard: Dashboard) => Number(new URL(dashboard.url).port);

/** Raw request so Host and the path bytes are exactly what the test chooses (fetch normalizes both). */
function raw(port: number, options: {path: string; method?: string; host?: string; headers?: Record<string, string>; body?: string}) {
  return new Promise<{status: number; headers: http.IncomingHttpHeaders; body: string}>((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port, path: options.path, method: options.method ?? 'GET', setHost: false,
      headers: {host: options.host ?? `127.0.0.1:${port}`, connection: 'close', ...options.headers}}, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString('utf8')}));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

async function login(dashboard: Dashboard) {
  const url = dashboard.url, token = new URL(dashboard.launchUrl).hash.slice('#token='.length);
  const response = await fetch(url + '/api/session', {method: 'POST', headers: {'content-type': 'application/json', origin: url}, body: JSON.stringify({token})});
  assert.equal(response.status, 200);
  const setCookie = response.headers.get('set-cookie')!;
  const cookie = setCookie.split(';')[0];
  const csrf = (await response.json() as {csrfToken: string}).csrfToken;
  const headers = {'content-type': 'application/json', origin: url, cookie, 'x-cmm-csrf': csrf};
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    const res = await fetch(url + '/api/command', {method: 'POST', headers, body: JSON.stringify({method, params})});
    return {status: res.status, body: await res.json() as any};
  };
  return {url, cookie, setCookie, csrf, headers, call};
}

async function fixture(t: {after: (fn: () => Promise<void>) => void}, count = 0) {
  const {manager, dir} = await makeManager();
  for (let i = 0; i < count; i++) await manager.recordToolComplete(sampleInput({toolCallId: 'hard-' + i, result: 'result ' + i}));
  const dashboard = await startDashboard({storage: dir});
  t.after(async () => {await dashboard.close(); await cleanup(dir, manager);});
  return {manager, dir, dashboard};
}

test('dashboard refuses a mismatched Host header (DNS rebinding) but serves the exact loopback host', async t => {
  const {dashboard} = await fixture(t);
  const port = portOf(dashboard);
  assert.equal((await raw(port, {path: '/'})).status, 200);
  for (const host of [`evil.example:${port}`, 'evil.example', `localhost:${port}`, `127.0.0.1:${port + 1}`, '']) {
    for (const path of ['/', '/api/session']) {
      const response = await raw(port, {path, host});
      assert.equal(response.status, 403, `${host || '(empty)'} ${path}`);
      assert.match(response.body, /HOST_REJECTED/);
      assert.doesNotMatch(response.body, /<script/);
    }
  }
});

test('static serving cannot escape the assets directory', async t => {
  const {dashboard} = await fixture(t);
  const port = portOf(dashboard);
  assert.equal((await raw(port, {path: '/index.html'})).status, 200);
  // ../server.js is the real sibling of the assets directory in every build layout, so a leak would be visible.
  for (const path of ['/../server.js', '/%2e%2e/server.js', '/%2E%2E/server.js', '/..%5cserver.js', '/..\\server.js', '/%2e%2e%5cserver.js',
    '/assets/../../server.js', '/assets/..%2f..%2fserver.js', '/./../server.js', '//../server.js', '/..%00/server.js', '/%5c..%5cserver.js', '/..%2fserver.js']) {
    const response = await raw(port, {path});
    assert.notEqual(response.status, 200, path);
    assert.doesNotMatch(response.body, /startDashboard|createReadStream/, path);
  }
  const missing = await raw(port, {path: '/not-here.js'});
  assert.equal(missing.status, 404);
  assert.equal((await raw(port, {path: '/index.html', method: 'POST'})).status, 405);
});

test('request bodies over the limit and non-JSON POSTs are refused before authentication logic', async t => {
  const {dashboard} = await fixture(t);
  const port = portOf(dashboard), origin = dashboard.url;
  const base = {'content-type': 'application/json', origin};
  const big = JSON.stringify({token: 'x'.repeat(128 * 1024 + 16)});
  const over = await raw(port, {path: '/api/session', method: 'POST', headers: {...base, 'content-length': String(Buffer.byteLength(big))}, body: big}).catch(e => e as NodeJS.ErrnoException);
  // The server may close the socket while the client is still writing; either way no success is acceptable.
  if (over instanceof Error) assert.match(String(over.code), /ECONNRESET|EPIPE/);
  else {assert.equal(over.status, 413); assert.match(over.body, /BODY_LIMIT/);}
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'application/jsonx', 'multipart/form-data; boundary=x']) {
    const response = await raw(port, {path: '/api/session', method: 'POST', headers: {...base, 'content-type': type}, body: '{"token":"a"}'});
    assert.equal(response.status, 415, type);
    assert.match(response.body, /JSON_REQUIRED/);
  }
  const missingType = await raw(port, {path: '/api/session', method: 'POST', headers: {origin}, body: '{}'});
  assert.equal(missingType.status, 415);
  const array = await raw(port, {path: '/api/session', method: 'POST', headers: base, body: '[]'});
  assert.equal(array.status, 400);
  // The cross-origin check applies to every API POST.
  assert.equal((await raw(port, {path: '/api/session', method: 'POST', headers: {...base, origin: 'http://evil.example'}, body: '{}'})).status, 403);
});

test('session cookie is named per port so two dashboards on 127.0.0.1 do not overwrite each other', async t => {
  const first = await fixture(t), second = await fixture(t);
  const a = await login(first.dashboard), b = await login(second.dashboard);
  assert.match(a.setCookie, new RegExp(`^cmm_session_${portOf(first.dashboard)}=[a-f0-9]{64}; HttpOnly; SameSite=Strict; Path=/api`));
  assert.match(b.setCookie, new RegExp(`^cmm_session_${portOf(second.dashboard)}=`));
  assert.notEqual(a.cookie.split('=')[0], b.cookie.split('=')[0]);
  // A browser holds both cookies and sends them together to either server.
  const both = `${a.cookie}; ${b.cookie}`;
  for (const [dashboard, session] of [[first.dashboard, a], [second.dashboard, b]] as const) {
    const res = await fetch(dashboard.url + '/api/session', {headers: {cookie: both}});
    assert.equal(res.status, 200);
    assert.equal((await res.json() as {csrfToken: string}).csrfToken, session.csrf);
  }
  // Another dashboard's cookie, or the old unscoped name, authenticates nothing.
  assert.equal((await fetch(first.dashboard.url + '/api/session', {headers: {cookie: b.cookie}})).status, 401);
  assert.equal((await fetch(first.dashboard.url + '/api/session', {headers: {cookie: a.cookie.replace(/^[^=]+/, 'cmm_session')}})).status, 401);
});

test('a pagination cursor issued before a settings save still works after it', async t => {
  const {dashboard} = await fixture(t, 4);
  const session = await login(dashboard);
  const scopeId = (await session.call('scopes')).body.result.scopes[0].id;
  const first = (await session.call('list', {scopeId, kind: 'events', limit: 2})).body.result;
  assert.equal(first.items.length, 2); assert.ok(first.nextCursor);
  const settings = (await session.call('settings')).body.result;
  const saved = await session.call('saveSettings', {expectedRevision: settings.revision, patch: {strategy: 'conservative'}});
  assert.equal(saved.status, 200); assert.equal(saved.body.result.adopted, true);
  const next = await session.call('list', {scopeId, kind: 'events', limit: 2, cursor: first.nextCursor});
  assert.equal(next.status, 200);
  assert.equal(next.body.result.items.length, 2);
  assert.ok(!next.body.result.items.some((i: any) => first.items.some((f: any) => f.id === i.id)));
  const tampered = await session.call('list', {scopeId, kind: 'events', limit: 2, cursor: first.nextCursor + 'x'});
  assert.equal(tampered.status, 400); assert.equal(tampered.body.error.code, 'INVALID_CURSOR');
});

test('known worker error kinds keep their status and code; unknown errors stay generic', async t => {
  const {manager, dashboard} = await fixture(t, 1);
  const session = await login(dashboard);
  const scopeId = (await session.call('scopes')).body.result.scopes[0].id;
  const settings = (await session.call('settings')).body.result;

  const stale = await session.call('saveSettings', {expectedRevision: '0'.repeat(64), patch: {strategy: 'aggressive'}});
  assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'CONFIG_CONFLICT');
  const staleProbe = await session.call('testProvider', {expectedRevision: '0'.repeat(64), role: 'retention', name: 'x'});
  assert.equal(staleProbe.status, 409);

  const foreign = await session.call('content', {scopeId: 'scope:forged', eventId: 'e'});
  assert.equal(foreign.status, 404); assert.equal(foreign.body.error.code, 'NOT_FOUND');
  const missingEvent = await session.call('detail', {scopeId, eventId: 'no-such-event'});
  assert.equal(missingEvent.status, 404); assert.equal(missingEvent.body.error.code, 'NOT_FOUND');
  const missingSession = await session.call('list', {scopeId, kind: 'events', sessionId: 'nope'});
  assert.equal(missingSession.status, 404);

  const invalid = await session.call('content', {scopeId, eventId: (await session.call('list', {scopeId, kind: 'events'})).body.result.items[0].id, limit: 64001});
  assert.equal(invalid.status, 400); assert.equal(invalid.body.error.code, 'INVALID_REQUEST');
  assert.match(invalid.body.error.message, /limit must be an integer/);
  const badSettings = await session.call('saveSettings', {expectedRevision: settings.revision, patch: {unknownField: 1}});
  assert.equal(badSettings.status, 400); assert.equal(badSettings.body.error.code, 'INVALID_SETTINGS');
  assert.match(badSettings.body.error.message, /Invalid settings field/);

  // Declared size over 32 MiB is a 413 before any original is read; a huge sibling field also stops the read.
  const id = manager.db.queryOne<{id: string}>('SELECT id FROM tool_events LIMIT 1')!.id;
  const row = manager.db.getToolEvent(id)!;
  manager.db.updateToolEvent(id, {result_bytes: 33 * 1024 * 1024});
  const toLarge = await fetch(dashboard.url + '/api/download?' + new URLSearchParams({scopeId, eventId: id, field: 'result'}), {headers: {cookie: session.cookie}});
  assert.equal(toLarge.status, 413); assert.equal((await toLarge.json() as any).error.code, 'SIZE_LIMIT');
  manager.db.updateToolEvent(id, {result_bytes: row.result_bytes, input_bytes: 65 * 1024 * 1024});
  const siblingLarge = await fetch(dashboard.url + '/api/download?' + new URLSearchParams({scopeId, eventId: id, field: 'result'}), {headers: {cookie: session.cookie}});
  assert.equal(siblingLarge.status, 413);
  manager.db.updateToolEvent(id, {input_bytes: row.input_bytes});
  const ok = await fetch(dashboard.url + '/api/download?' + new URLSearchParams({scopeId, eventId: id, field: 'result'}), {headers: {cookie: session.cookie}});
  assert.equal(ok.status, 200);

  // A corrupt original is an unknown failure: generic message, never the internal one.
  manager.db.updateToolEvent(id, {result_ref: 'corrupt'});
  const corrupt = await session.call('content', {scopeId, eventId: id});
  assert.equal(corrupt.body.error.code, 'OPERATION_FAILED');
  assert.doesNotMatch(JSON.stringify(corrupt.body), /corrupt|blob|sha/i);
});

test('publicFailure allowlists safe kinds and never forwards provider bodies, paths or captured text', () => {
  assert.deepEqual(publicFailure(new ManagementError(409, 'MAINTENANCE_RUNNING', 'Maintenance already running'))?.status, 409);
  assert.equal(publicFailure(Object.assign(new Error('x'), {name: 'ConfigConflictError'}))?.status, 409);
  const left = publicFailure(new ConfigLockLeftError(defaultConfig('C:\\private\\storage')), 'saveSettings');
  assert.deepEqual([left?.status, left?.code], [500, 'CONFIG_LOCK_LEFT']);
  assert.ok(!/[A-Za-z]:\\|private/.test(left!.message) && /config\.write\.lock/.test(left!.message));
  assert.equal(publicFailure(new Error('limit must be an integer in [1, 100]'))?.code, 'INVALID_REQUEST');
  assert.equal(publicFailure(new Error('Configuration writer lock C:\\x\\config.json.lock is held (pid 4)'))?.code, 'CONFIG_BUSY');
  for (const error of [
    new Error('Provider returned 401: {"error":"sk-secret-body"}'),
    new SyntaxError('Unexpected token in JSON at position 4: "captured secret"'),
    Object.assign(new Error('ENOENT: no such file C:\\Users\\me\\secret.txt'), {code: 'ENOENT'}),
    new Error('Cannot read C:\\storage\\config.json; configuration was not reset.'),
  ]) assert.equal(publicFailure(error), undefined);
  // Settings validation text is only forwarded for settings methods, and never when it carries paths or lock details.
  assert.equal(publicFailure(new Error('Cannot read C:\\storage\\config.json; x'), 'saveSettings'), undefined);
  assert.equal(publicFailure(new Error('Provider names must be unique'), 'saveSettings')?.code, 'INVALID_SETTINGS');
  assert.equal(publicFailure(new Error('Provider names must be unique'), 'content'), undefined);
});

test('static asset read errors end the response without crashing the server', async t => {
  const {dashboard} = await fixture(t);
  const port = portOf(dashboard);
  // Abort mid-response many times; the server must stay healthy and keep serving.
  await Promise.all(Array.from({length: 20}, () => new Promise<void>(resolve => {
    const req = http.get({host: '127.0.0.1', port, path: '/index.html', headers: {connection: 'close'}}, res => {res.destroy(); resolve();});
    req.on('error', () => resolve());
  })));
  assert.equal((await raw(port, {path: '/index.html'})).status, 200);
});

test('unexpected worker exit stops the dashboard instead of leaving a permanently broken panel', async t => {
  const {dashboard} = await fixture(t);
  const session = await login(dashboard);
  assert.equal((await session.call('scopes')).status, 200);
  const port = portOf(dashboard);
  process.kill(dashboard.workerPid!);
  await Promise.race([dashboard.exited, new Promise((_, reject) => setTimeout(() => reject(new Error('dashboard did not stop')), 15000).unref())]);
  assert.equal(dashboard.server.listening, false);
  await assert.rejects(raw(port, {path: '/'}), /ECONNREFUSED/);
  await dashboard.close(); // idempotent after the automatic stop
});

// --- CLI lifecycle -----------------------------------------------------------------------------------------------
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function launch(storage: string) {
  const child = spawn(process.execPath, [cli, 'dashboard', '--storage', storage, '--port', '0'], {stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
  let out = '', err = '';
  child.stderr!.on('data', c => err += c);
  const exited = new Promise<{code: number | null; signal: NodeJS.Signals | null}>(resolve => child.once('exit', (code, signal) => resolve({code, signal})));
  const started = new Promise<{dashboard: string; launchUrl: string}>((resolve, reject) => {
    child.stdout!.on('data', c => {
      out += c;
      try {resolve(JSON.parse(out));} catch {/* wait for the rest of the pretty-printed JSON */}
    });
    void exited.then(() => reject(new Error('dashboard exited before printing its launch URL: ' + err)));
  });
  return {child, started, exited, stderr: () => err};
}
const within = <T>(promise: Promise<T>, ms: number, label: string) =>
  Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(label + ' timed out')), ms).unref())]);
function childPids(parent: number): number[] {
  if (process.platform === 'win32') {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${parent}").ProcessId`], {encoding: 'utf8', windowsHide: true});
    return out.split(/\s+/).filter(Boolean).map(Number);
  }
  try {return execFileSync('pgrep', ['-P', String(parent)], {encoding: 'utf8'}).split(/\s+/).filter(Boolean).map(Number);} catch {return [];}
}
const killTree = (child: ChildProcess) => {try {child.kill('SIGKILL');} catch {/* already gone */}};

test('cmm dashboard exits by itself with code 0 after stdin EOF and closes its port', async t => {
  const {manager, dir} = await makeManager();
  await manager.recordToolComplete(sampleInput());
  t.after(() => cleanup(dir, manager));
  const run = launch(dir);
  t.after(() => killTree(run.child));
  const info = await within(run.started, 20000, 'launch URL');
  const url = new URL(info.dashboard);
  assert.equal(url.hostname, '127.0.0.1');
  assert.notEqual(url.port, '0');
  assert.equal((await fetch(info.dashboard + '/')).status, 200);
  run.child.stdin!.end();
  const result = await within(run.exited, 20000, 'process exit');
  assert.equal(result.code, 0, run.stderr());
  await assert.rejects(fetch(info.dashboard + '/'), /fetch failed/);
});

test('cmm dashboard exits non-zero with a clear message when its worker dies', async t => {
  const {manager, dir} = await makeManager();
  await manager.recordToolComplete(sampleInput());
  t.after(() => cleanup(dir, manager));
  const run = launch(dir);
  t.after(() => killTree(run.child));
  const info = await within(run.started, 20000, 'launch URL');
  const workers = childPids(run.child.pid!);
  assert.ok(workers.length >= 1, 'worker process found');
  for (const pid of workers) try {process.kill(pid);} catch {/* not a node child */}
  const result = await within(run.exited, 20000, 'process exit');
  assert.equal(result.code, 1);
  assert.match(run.stderr(), /dashboard worker stopped unexpectedly; restart the dashboard/);
  assert.equal(run.stderr().trim().split(/\r?\n/).length, 1, 'one-line message');
  await assert.rejects(fetch(info.dashboard + '/'), /fetch failed/);
});
