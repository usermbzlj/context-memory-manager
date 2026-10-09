import '../util/quiet-sqlite.js';
import { ContextManager } from '../core/context-manager.js';
import { MemoryService } from '../runtime/memory.js';
import { ManagementService, ManagementError, publicFailure } from '../management/service.js';
import { configRevision } from '../config.js';

const storage = process.argv[2];
let manager: ContextManager;
let service: ManagementService;
let closing = false;
const jobs = new Map<string, AbortController>();
const send = (value: unknown) => { if (process.connected) process.send?.(value); };
const generic = { code: 'OPERATION_FAILED', status: 400, message: '操作未完成，请检查参数、作用范围或配置版本。' };
// Only allowlisted kinds keep their status/code; provider bodies, paths and captured text never leave this process.
const failure = (error: unknown, method?: string) => publicFailure(error, method) ?? generic;
try {
  manager = ContextManager.open(storage,undefined,{component:'worker',persistent:true});
  service = new ManagementService(manager);
  send({ type: 'ready', pid: process.pid });
} catch {
  send({ type: 'fatal', message: '无法打开所选 CMM 存储。' });
  process.exit(1);
}
/** Reports a job outcome once; the entry is released only after the terminal message is sent. */
function endJob(id: string, status: 'completed' | 'cancelled' | 'failed', payload: { result?: unknown } = {}) {
  const controller = jobs.get(id); if (!controller) return;
  jobs.delete(id);
  send({ type: 'jobEnd', id, status, ...payload,
    ...(status === 'completed' ? {} : { error: { code: status.toUpperCase(), message: '校验已中断或失败。' } }) });
}
let queue = Promise.resolve();
process.on('message', (raw: unknown) => {
  const msg = raw as { id: number; method: string; params: Record<string, unknown> };
  if (!msg || typeof msg.id !== 'number' || typeof msg.method !== 'string' || !msg.params || typeof msg.params !== 'object') return;
  const reply = (error: unknown) => send({ type: 'response', id: msg.id, error: failure(error, msg.method) });
  try {
    if (msg.method === 'cancelJob') {
      const controller = jobs.get(String(msg.params.id));
      controller?.abort();
      send({ type: 'response', id: msg.id, result: { cancelled: Boolean(controller) } });
      return;
    }
  } catch (error) { reply(error); return; }
  queue = queue.then(async () => {
    if (closing) throw new ManagementError(503, 'WORKER_CLOSING', 'Closing');
    if (msg.method === 'startJob') {
      const id = String(msg.params.id);
      const scope = service.resolveScope(String(msg.params.scopeId));
      if (jobs.size) throw new ManagementError(409, 'MAINTENANCE_RUNNING', 'Maintenance already running');
      const controller = new AbortController();
      jobs.set(id, controller);
      const memory = new MemoryService(manager, scope);
      send({ type: 'response', id: msg.id, result: { accepted: true } });
      // A throw while reporting must not escape as an unhandled rejection; the job is closed as failed instead.
      void memory.verify(msg.params.reindex === true, { signal: controller.signal,
        onProgress: progress => send({ type: 'jobProgress', id, progress }) }).then(result => {
          const { integrity: _integrity, failures, ...summary }=result;
          endJob(id, 'completed', { result: {...summary,
            failures:failures.map(item=>({eventId:item.eventId,code:'INTEGRITY_CHECK_FAILED'}))} });
        }).catch(() => endJob(id, controller.signal.aborted ? 'cancelled' : 'failed'))
        .finally(() => { jobs.delete(id); });
      return;
    }
    if (msg.method === 'saveSettings' && jobs.size) throw new ManagementError(409, 'MAINTENANCE_RUNNING', 'Maintenance is running');
    const result = await service.execute(msg.method, msg.params);
    if (msg.method === 'saveSettings') {
      manager.close();
      try { manager = ContextManager.open(storage,undefined,{component:'worker',persistent:true}); }
      catch (error) {
        // The saved settings are durable but this process has no open archive; exiting lets the dashboard stop visibly.
        reply(error); setTimeout(() => process.exit(1), 50); return;
      }
      service = new ManagementService(manager);
      manager.runtime.update({ configRevision: configRevision(storage) });
      send({ type: 'response', id: msg.id, result: { ...(result as object), adopted: true,
        reloadRequiredForHosts: true } });
    } else send({ type: 'response', id: msg.id, result });
  }).catch(reply);
});
// A stray rejection or callback throw must not take the panel down; running jobs are reported as failed.
// Truly unknown synchronous crashes still exit, which the dashboard treats as fatal.
process.on('unhandledRejection', () => { for (const [id, controller] of [...jobs]) { controller.abort(); endJob(id, 'failed'); } });
async function close() {
  if (closing) return;
  closing = true;
  for (const controller of jobs.values()) controller.abort();
  await queue;
  // Cancellation yields between verified records, allowing cooperative shutdown.
  const deadline = Date.now() + 1500;
  while (jobs.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  try { manager.close(); }
  finally { process.disconnect?.(); process.exit(0); }
}
process.stdin.resume();
process.stdin.on('end', () => { void close(); });
process.on('disconnect', () => { void close(); });
process.on('SIGTERM', () => { void close(); });
