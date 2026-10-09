import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

// This is a lossy diagnostics channel, never an archive or instruction channel.
// Fixed slots bound disk use even when thousands of short-lived hooks run.
export const RUNTIME_LIMITS = Object.freeze({ slots: 128, events: 64, activities: 32,
  fileBytes: 64 * 1024, leaseMs: 15_000, staleMs: 15_000, heartbeatMs: 3_000 });
const kinds = new Set(['capture','archive','index','score','capsule','chain','provider','verify','reindex','pin','unpin','config','maintenance']);
const components = new Set(['manager','hook','bridge','worker','dashboard']);
const statuses = new Set(['ok','error','fallback','cancelled']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface RuntimeScope { agent: string; workspaceId: string }
export type RuntimeKind = 'capture'|'archive'|'index'|'score'|'capsule'|'chain'|'provider'|'verify'|'reindex'|'pin'|'unpin'|'config'|'maintenance';
export type RuntimeComponent = 'manager'|'hook'|'bridge'|'worker'|'dashboard';
export interface OperationInput { kind: RuntimeKind; scope?: RuntimeScope; role?: 'retention'|'capsule'|'chain'; provider?: string; model?: string; eventId?: string }
export interface OperationResult { status?: 'ok'|'error'|'fallback'|'cancelled'; eventId?: string; model?: string }
export interface RuntimeActivity extends OperationInput { id: string; instanceId: string; source: 'runtime-file'; observedAt: number; startedAt: number }
export interface RuntimeEvent extends RuntimeActivity { phase: 'start'|'end'; status?: OperationResult['status']; endedAt?: number; durationMs?: number }
interface Lease { version: 1; leaseId: string; observedAt: number }
interface InstanceFile {
  version: 1; leaseId: string; instanceId: string; pid: number; component: RuntimeComponent;
  source: 'runtime-file'; startedAt: number; observedAt: number; stoppedAt?: number;
  scope?: RuntimeScope; configRevision?: string; activities: RuntimeActivity[]; events: RuntimeEvent[]; dropped: number;
}
export interface RuntimeInstance extends Omit<InstanceFile,'activities'|'events'> { state: 'idle'|'busy'|'stopped'|'stale'; stale: boolean; activityCount: number }
export interface RuntimeSnapshot { observedAt: number; enabled: boolean; leaseId?: string; instances: RuntimeInstance[];
  activities: RuntimeActivity[]; events: RuntimeEvent[]; truncated: boolean; coverage: 'bounded-best-effort' }
export interface ObserverOptions { component?: RuntimeComponent; scope?: RuntimeScope; configRevision?: string; persistent?: boolean }

function identifier(value: unknown, max = 100): string | undefined {
  // Provider/model labels are identifiers, not arbitrary text or error bodies.
  if (typeof value !== 'string' || value.length > max || !/^[\w.:-]+$/.test(value) ||
      /(?:^sk-|^sess-|bearer|api.?key|secret|password|credential)/i.test(value)) return undefined;
  return value;
}
function cleanScope(value?: RuntimeScope): RuntimeScope | undefined {
  const agent = identifier(value?.agent,200);
  const workspaceId = value?.workspaceId;
  return agent && typeof workspaceId === 'string' && workspaceId.length <= 4096 &&
    !/[\x00-\x1f]/.test(workspaceId) ? { agent, workspaceId } : undefined;
}
function metadata(input: OperationInput): OperationInput | undefined {
  if (!kinds.has(input.kind)) return undefined;
  const scope = cleanScope(input.scope);
  const out: OperationInput = { kind: input.kind };
  if (scope) out.scope = scope;
  if (['retention','capsule','chain'].includes(input.role ?? '')) out.role = input.role;
  const provider = identifier(input.provider), model = identifier(input.model);
  if (provider) out.provider = provider;
  if (model) out.model = model;
  // Event handles are exposed only with their source scope.
  if (scope && typeof input.eventId === 'string' && uuid.test(input.eventId)) out.eventId = input.eventId;
  return out;
}
function readSmall(file: string): unknown {
  const fd = fs.openSync(file,'r');
  try {
    const stat=fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > RUNTIME_LIMITS.fileBytes) return undefined;
    const bytes = Buffer.alloc(RUNTIME_LIMITS.fileBytes + 1);
    const count = fs.readSync(fd,bytes,0,bytes.length,0);
    if (count > RUNTIME_LIMITS.fileBytes) return undefined;
    return JSON.parse(bytes.subarray(0,count).toString('utf8'));
  } finally { fs.closeSync(fd); }
}
function lease(storage: string): Lease | undefined {
  try {
    const value = readSmall(path.join(storage,'runtime','observer.json')) as Lease;
    const age = Date.now() - value.observedAt;
    if (value.version === 1 && uuid.test(value.leaseId) && Number.isFinite(age) && age >= -1000 && age < RUNTIME_LIMITS.leaseMs) return value;
  } catch { /* Observation is always fail-open. */ }
  return undefined;
}
function writeSmall(file: string, value: unknown, flag: 'w'|'wx' = 'w'): void {
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > RUNTIME_LIMITS.fileBytes) throw new Error('Runtime metadata bound exceeded');
  fs.writeFileSync(file,encoded,{flag,mode:0o600});
}

/** A dashboard-owned lease. Losing or stopping it never affects capture. */
export function enableRuntime(storage: string): { leaseId: string; stop(): void } {
  const leaseId = randomUUID();
  const file = path.join(storage,'runtime','observer.json');
  let stopped = false;
  try { fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700}); writeSmall(file,{version:1,leaseId,observedAt:Date.now()}); } catch { /* fail-open */ }
  const timer = setInterval(() => {
    if (stopped) return;
    try {
      const current = readSmall(file) as Lease;
      if (current.leaseId !== leaseId) return;
      writeSmall(file,{version:1,leaseId,observedAt:Date.now()});
    } catch { /* No diagnostics retries in the host tool path. */ }
  },RUNTIME_LIMITS.heartbeatMs);
  timer.unref();
  return { leaseId, stop() {
    if (stopped) return;
    stopped = true; clearInterval(timer);
    try { if ((readSmall(file) as Lease).leaseId === leaseId) fs.unlinkSync(file); } catch { /* fail-open */ }
  } };
}

export class RuntimeObserver {
  readonly instanceId = randomUUID();
  private readonly context = new AsyncLocalStorage<{scope:RuntimeScope;fallback:boolean}>();
  private state?: InstanceFile;
  private file?: string;
  private timer?: NodeJS.Timeout;
  private closed = false;
  private scope?: RuntimeScope;
  private revision?: string;
  private deniedUntil = 0;
  constructor(private readonly storage: string, private readonly options: ObserverOptions = {}) {
    this.scope = cleanScope(options.scope); this.revision = identifier(options.configRevision);
    this.ensure();
  }
  setScope(scope: RuntimeScope): void { this.scope = cleanScope(scope); if (this.state) this.state.scope = this.scope; this.publish(); }
  update(input: {configRevision?: string}): void {
    this.revision = identifier(input.configRevision); if (this.state) this.state.configRevision = this.revision; this.publish();
  }
  withScope<T>(scope: RuntimeScope, work: () => T): T {
    const safe = cleanScope(scope); return safe ? this.context.run({scope:safe,fallback:false},work) : work();
  }
  /** Called only for the core's fixed 'model fallback' event name, never its fields. */
  noteFallback(): void { const context=this.context.getStore();if(context)context.fallback=true; }
  private ensure(): boolean {
    if (this.closed || Date.now() < this.deniedUntil) return false;
    const current = lease(this.storage);
    if (!current) {
      if (this.timer) {clearInterval(this.timer);this.timer=undefined;}
      this.deniedUntil = Date.now()+250; return false;
    }
    if (this.state?.leaseId === current.leaseId && this.file) {this.startHeartbeat();return true;}
    const now = Date.now();
    const state: InstanceFile = {version:1,leaseId:current.leaseId,instanceId:this.instanceId,pid:process.pid,
      component:components.has(this.options.component ?? '') ? this.options.component! : 'manager',source:'runtime-file',
      startedAt:now,observedAt:now,scope:this.scope,configRevision:this.revision,activities:[],events:[],dropped:0};
    // Exclusive-create empty slots first; recycle only stopped, expired or previous-lease metadata.
    const start = Number.parseInt(this.instanceId.slice(0,8),16) % RUNTIME_LIMITS.slots;
    try {
      for (let pass=0;pass<2;pass++) for (let n=0;n<RUNTIME_LIMITS.slots;n++) {
        const file = path.join(this.storage,'runtime',`slot-${String((start+n)%RUNTIME_LIMITS.slots).padStart(3,'0')}.json`);
        if (pass === 0) {
          try { writeSmall(file,state,'wx'); } catch { continue; }
        } else {
          try {
            let old: InstanceFile | undefined;
            try {old=readSmall(file) as InstanceFile;} catch {
              // A crash can interrupt a diagnostics write. Reclaim it after
              // the same stale interval, never during a fresh partial write.
              if (now-fs.statSync(file).mtimeMs<RUNTIME_LIMITS.staleMs) continue;
            }
            if (old?.leaseId === current.leaseId && !old.stoppedAt && now-old.observedAt < RUNTIME_LIMITS.staleMs) continue;
            writeSmall(file,state);
          } catch { continue; }
        }
        this.file = file; this.state = state;
        this.startHeartbeat();
        return true;
      }
    } catch { /* Exhaustion/unavailable channel is not a capture error. */ }
    this.deniedUntil = now+250; return false;
  }
  private startHeartbeat(): void {
    if (this.options.persistent !== false && !this.timer) {
      this.timer=setInterval(()=>this.publish(),RUNTIME_LIMITS.heartbeatMs);this.timer.unref();
    }
  }
  private publish(): void {
    try {
      if (!this.ensure() || !this.state || !this.file) return;
      // A stalled process must never resurrect metadata after its slot was recycled.
      if ((readSmall(this.file) as InstanceFile).instanceId !== this.instanceId) { this.file=undefined; this.state=undefined; return; }
      this.state.observedAt = Date.now(); writeSmall(this.file,this.state);
    } catch { /* Never expose or persist the raw filesystem error. */ }
  }
  operation(input: OperationInput): (result?: OperationResult) => void {
    let activity: RuntimeActivity | undefined;
    const context=this.context.getStore();
    try {
      const safe = metadata({...input,scope:input.scope ?? context?.scope ?? this.scope});
      if (!safe || !this.ensure() || !this.state) return () => {};
      if (this.state.activities.length >= RUNTIME_LIMITS.activities) { this.state.dropped++; this.publish(); return () => {}; }
      const now = Date.now();
      activity = {...safe,id:randomUUID(),instanceId:this.instanceId,source:'runtime-file',observedAt:now,startedAt:now};
      this.state.activities.push(activity); this.event({...activity,phase:'start'});
      if (Buffer.byteLength(JSON.stringify(this.state))>RUNTIME_LIMITS.fileBytes) {
        this.state.activities.pop(); this.state.dropped++; this.publish(); return () => {};
      }
      this.publish();
    } catch { return () => {}; }
    let ended = false;
    return (result = {}) => {
      if (ended) return; ended = true;
      try {
        if (!activity || !this.ensure() || !this.state || !this.state.activities.some(item => item.id===activity!.id)) return;
        this.state.activities = this.state.activities.filter(item => item.id!==activity!.id);
        const endedAt = Date.now();
        const extra = metadata({...activity,...result});
        this.event({...activity,...extra,phase:'end',observedAt:endedAt,endedAt,durationMs:Math.max(0,endedAt-activity.startedAt),
          status:activity.kind==='score' && context?.fallback && (!result.status || result.status==='ok') ? 'fallback' :
            statuses.has(result.status ?? '') ? result.status : 'ok'});
        this.publish();
      } catch { /* fail-open */ }
    };
  }
  private event(event: RuntimeEvent): void {
    if (!this.state) return;
    this.state.events.push(event);
    if (this.state.events.length>RUNTIME_LIMITS.events) {this.state.events.shift(); this.state.dropped++;}
    // Large workspace metadata can hit the byte bound before the entry count bound.
    while (Buffer.byteLength(JSON.stringify(this.state))>RUNTIME_LIMITS.fileBytes && this.state.events.length) {
      this.state.events.shift(); this.state.dropped++;
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) {clearInterval(this.timer);this.timer=undefined;}
    try {
      // Closing an old instance cannot create a fresh-looking entry in a new lease.
      if (this.state && this.file && lease(this.storage)?.leaseId===this.state.leaseId &&
          (readSmall(this.file) as InstanceFile).instanceId===this.instanceId) {
        this.state.stoppedAt=Date.now();this.state.observedAt=this.state.stoppedAt;this.state.activities=[];
        writeSmall(this.file,this.state);
      }
    } catch { /* fail-open */ }
  }
}
export function createRuntimeObserver(storage: string, options: ObserverOptions = {}): RuntimeObserver { return new RuntimeObserver(storage,options); }
export function observeOperation(storage: string, input: OperationInput): (result?: OperationResult) => void {
  const observer = createRuntimeObserver(storage,{component:'worker',scope:input.scope,persistent:false});
  const end = observer.operation(input);
  return result => {end(result); observer.close();};
}

function sameScope(actual: RuntimeScope|undefined, requested: RuntimeScope): boolean {
  return actual?.agent===requested.agent && actual.workspaceId===requested.workspaceId;
}
/** Reads a fixed number of fixed-size files; never opens the archive or contacts models. */
export function readRuntime(storage: string, scope?: RuntimeScope): RuntimeSnapshot {
  const observedAt = Date.now(), current = lease(storage);
  const snapshot: RuntimeSnapshot = {observedAt,enabled:Boolean(current),leaseId:current?.leaseId,
    instances:[],activities:[],events:[],truncated:false,coverage:'bounded-best-effort'};
  const filter = scope ? cleanScope(scope) : undefined;
  if (scope && !filter) return snapshot;
  for (let i=0;i<RUNTIME_LIMITS.slots;i++) try {
    const value = readSmall(path.join(storage,'runtime',`slot-${String(i).padStart(3,'0')}.json`)) as InstanceFile;
    if (!value || value.version!==1 || !uuid.test(value.instanceId) || !uuid.test(value.leaseId) || !components.has(value.component) ||
      !Number.isFinite(value.observedAt) || !Number.isFinite(value.startedAt) || !Array.isArray(value.activities) || !Array.isArray(value.events)) continue;
    if (current && current.leaseId!==value.leaseId) continue;
    // Reconstruct every DTO from an allowlist; corrupted/local files cannot inject source/error text.
    const items = (raw: unknown[], phase: boolean): RuntimeEvent[] => raw.slice(-RUNTIME_LIMITS.events).flatMap<RuntimeEvent>(item => {
      if (!item || typeof item!=='object') return [];
      const e = item as RuntimeEvent, safe=metadata(e);
      if (!safe || !uuid.test(e.id) || e.instanceId!==value.instanceId || !Number.isFinite(e.startedAt) || !Number.isFinite(e.observedAt) ||
          (filter && !sameScope(safe.scope,filter))) return [];
      const base = {...safe,id:e.id,instanceId:value.instanceId,source:'runtime-file' as const,startedAt:e.startedAt,observedAt:e.observedAt};
      if (!phase) return [{...base,phase:'start' as const}];
      if (!['start','end'].includes(e.phase)) return [];
      return [{...base,phase:e.phase,status:statuses.has(e.status ?? '')?e.status:undefined,
        endedAt:Number.isFinite(e.endedAt)?e.endedAt:undefined,durationMs:Number.isFinite(e.durationMs)?Math.max(0,e.durationMs!):undefined}];
    });
    const events=items(value.events,true), activities=items(value.activities,false).slice(0,RUNTIME_LIMITS.activities).map(({phase,...item})=>item);
    const instanceScope=cleanScope(value.scope);
    if (filter && !sameScope(instanceScope,filter) && !events.length && !activities.length) continue;
    const stale = !current || observedAt-value.observedAt>=RUNTIME_LIMITS.staleMs || value.observedAt>observedAt+1000;
    const stoppedAt = Number.isFinite(value.stoppedAt) ? value.stoppedAt : undefined;
    const instance: RuntimeInstance = {version:1,leaseId:value.leaseId,instanceId:value.instanceId,pid:Number.isSafeInteger(value.pid)?value.pid:0,
      component:value.component,source:'runtime-file',startedAt:value.startedAt,observedAt:value.observedAt,stoppedAt,
      scope:filter ? filter : instanceScope,configRevision:identifier(value.configRevision),activityCount:activities.length,
      dropped:Number.isSafeInteger(value.dropped)&&value.dropped>=0?value.dropped:0,stale,
      state:stoppedAt?'stopped':stale?'stale':activities.length?'busy':'idle'};
    snapshot.instances.push(instance); snapshot.events.push(...events);
    // A stale activity is not presented as currently running.
    if (!stale && !stoppedAt) snapshot.activities.push(...activities);
    if (instance.dropped) snapshot.truncated=true;
  } catch { /* Incomplete writes and inaccessible channel yield missing observations. */ }
  snapshot.events.sort((a,b)=>a.observedAt-b.observedAt);
  if (snapshot.events.length>256) {snapshot.events=snapshot.events.slice(-256); snapshot.truncated=true;}
  if (snapshot.activities.length>128) {snapshot.activities=snapshot.activities.slice(-128); snapshot.truncated=true;}
  return snapshot;
}
