import { ContextManager } from '../core/context-manager.js';
import { MemoryService } from '../runtime/memory.js';
import { ManagementService } from '../management/service.js';
import { configRevision } from '../config.js';

const storage = process.argv[2];
let manager: ContextManager;
let service: ManagementService;
let closing = false;
const jobs = new Map<string, AbortController>();
const send = (value: unknown) => { if (process.connected) process.send?.(value); };
const failure = (error: unknown) => {
  const e = error as { code?: string; status?: number; name?: string };
  return { code: e.code ?? (e.name === 'ConfigConflictError' ? 'CONFIG_CONFLICT' : 'OPERATION_FAILED'),
    status: e.status ?? (e.name === 'ConfigConflictError' ? 409 : 400),
    message: '操作未完成，请检查参数、作用范围或配置版本。' };
};
try {
  manager = ContextManager.open(storage,undefined,{component:'worker',persistent:true});
  service = new ManagementService(manager);
  send({ type: 'ready', pid: process.pid });
} catch {
  send({ type: 'fatal', message: '无法打开所选 CMM 存储。' });
  process.exit(1);
}
let queue = Promise.resolve();
process.on('message', (raw: unknown) => {
  const msg = raw as { id: number; method: string; params: Record<string, unknown> };
  if (!msg || typeof msg.id !== 'number' || typeof msg.method !== 'string' || !msg.params) return;
  if (msg.method === 'cancelJob') {
    jobs.get(String(msg.params.id))?.abort();
    send({ type: 'response', id: msg.id, result: { cancelled: jobs.has(String(msg.params.id)) } });
    return;
  }
  queue = queue.then(async () => {
    if (closing) throw new Error('Closing');
    if (msg.method === 'startJob') {
      const id = String(msg.params.id);
      const scope = service.resolveScope(String(msg.params.scopeId));
      if (jobs.size) throw new Error('Maintenance already running');
      const controller = new AbortController();
      jobs.set(id, controller);
      const memory = new MemoryService(manager, scope);
      send({ type: 'response', id: msg.id, result: { accepted: true } });
      void memory.verify(msg.params.reindex === true, { signal: controller.signal,
        onProgress: progress => send({ type: 'jobProgress', id, progress }) }).then(result => {
          const { integrity: _integrity, failures, ...summary }=result;
          send({ type: 'jobEnd', id, status: 'completed', result: {...summary,
            failures:failures.map(item=>({eventId:item.eventId,code:'INTEGRITY_CHECK_FAILED'}))} });
        }, () => {
          const status = controller.signal.aborted ? 'cancelled' : 'failed';
          send({ type: 'jobEnd', id, status, error: { code: status.toUpperCase(), message: '校验已中断或失败。' } });
        }).finally(() => jobs.delete(id));
      return;
    }
    if (msg.method === 'saveSettings' && jobs.size) throw new Error('Maintenance is running');
    const result = await service.execute(msg.method, msg.params);
    if (msg.method === 'saveSettings') {
      manager.close();
      manager = ContextManager.open(storage,undefined,{component:'worker',persistent:true});
      service = new ManagementService(manager);
      manager.runtime.update({ configRevision: configRevision(storage) });
      send({ type: 'response', id: msg.id, result: { ...(result as object), adopted: true,
        reloadRequiredForHosts: true } });
    } else send({ type: 'response', id: msg.id, result });
  }).catch(error => send({ type: 'response', id: msg.id, error: failure(error) }));
});
async function close() {
  if (closing) return;
  closing = true;
  for (const controller of jobs.values()) controller.abort();
  await queue;
  // Cancellation yields between verified records, allowing cooperative shutdown.
  const deadline = Date.now() + 1500;
  while (jobs.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  manager.close();
  process.disconnect?.();
  process.exit(0);
}
process.stdin.resume();
process.stdin.on('end', () => { void close(); });
process.on('disconnect', () => { void close(); });
process.on('SIGTERM', () => { void close(); });
