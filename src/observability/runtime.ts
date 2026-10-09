import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

// This is a lossy diagnostics channel, never an archive or instruction channel.
// Fixed slots bound disk use even when thousands of short-lived hooks run.
export const RUNTIME_LIMITS = Object.freeze({ slots: 128, events: 64, activities: 32,
  fileBytes: 64 * 1024, leaseMs: 15_000, staleMs: 15_000, heartbeatMs: 3_000,
  leaseCacheMs: 1_000, publishMs: 250, probes: 16 });
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
export interface ObserverOptions { component?: RuntimeComponent; scope?: RuntimeScope; configRevision?: string; persistent?: boolean;
  /** Test seams for the lease-read cache and publish coalescing windows (defaults in RUNTIME_LIMITS). */ leaseCacheMs?: number; publishMs?: number }

function identifier(value: unknown, max = 100): string | undefined {
  // Provider/model labels are identifiers, not arbitrary text or error bodies.
  if (typeof value !== 'string' || value.length > max || !/^[\w.:-]+$/.test(value) ||
      /(?:^sk-|^sess-|bearer|api.?key|secret|password|credential)/i.test(value)) return undefined;
  return value;
}
function cleanScope(value?: RuntimeScope): RuntimeScope | undefined {
  const agent = identifier(value?.agent,200);
  const workspaceId = value?.workspaceId;
  if (!agent || typeof workspaceId !== 'string' || workspaceId.length > 4096 || /[\x00-\x1f]/.test(workspaceId)) return undefined;
  // Long ids are replaced by a stable digest (applied to readers' filters too) so scope strings cannot exhaust the 64 KiB file.
  return { agent, workspaceId: workspaceId.length > 256 ? `sha256:${createHash('sha256').update(workspaceId).digest('hex').slice(0,32)}` : workspaceId };
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
const transientCodes = new Set(['EPERM','EBUSY','EACCES']);
const codeOf = (error: unknown): unknown => (error as NodeJS.ErrnoException | undefined)?.code;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
/** Bounded synchronous pause for Windows sharing violations; never used on a hot path without a failure. */
function pause(ms: number): void { Atomics.wait(sleeper,0,0,ms); }
function readSmall(file: string): unknown {
  let fd: number;
  // A concurrent rename can briefly deny open on Windows; a missing file is returned to the caller as is.
  for (let attempt=0;;attempt++) {
    try { fd=fs.openSync(file,'r'); break; }
    catch (error) { if (attempt>=2 || !transientCodes.has(String(codeOf(error)))) throw error; pause(2); }
  }
  try {
    const stat=fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > RUNTIME_LIMITS.fileBytes) return undefined;
    const bytes = Buffer.alloc(RUNTIME_LIMITS.fileBytes + 1);
    const count = fs.readSync(fd,bytes,0,bytes.length,0);
    if (count > RUNTIME_LIMITS.fileBytes) return undefined;
    return JSON.parse(bytes.subarray(0,count).toString('utf8'));
  } finally { fs.closeSync(fd); }
}
/**
 * `definitive` means the dashboard's answer is known: a parsed lease, or no lease file at all (the dashboard stopped).
 * A file that exists but cannot be read or parsed right now (sharing violation, torn write) is only "unknown".
 */
function readLease(storage: string): { lease?: Lease; definitive: boolean } {
  let value: Lease;
  try { value = readSmall(path.join(storage,'runtime','observer.json')) as Lease; }
  catch (error) { return { definitive: codeOf(error)==='ENOENT' }; }
  if (!value || typeof value !== 'object') return { definitive: false };
  const age = Date.now() - value.observedAt;
  if (value.version === 1 && uuid.test(value.leaseId) && Number.isFinite(age) && age >= -1000 && age < RUNTIME_LIMITS.leaseMs) return { lease: value, definitive: true };
  return { definitive: true };
}
function lease(storage: string): Lease | undefined { return readLease(storage).lease; }
/**
 * Replace atomically so readers see the old or new file, never a truncated one. `exclusive` creates in place
 * (a brand-new slot) and fails if the file exists. Windows may refuse the rename while a reader holds the target.
 */
function writeSmall(file: string, encoded: string, exclusive = false): void {
  if (Buffer.byteLength(encoded) > RUNTIME_LIMITS.fileBytes) throw new Error('Runtime metadata bound exceeded');
  // EEXIST means the name belongs to someone else; any other failure may have left a partial file of ours behind.
  const create = (target: string): void => {
    try { fs.writeFileSync(target,encoded,{flag:'wx',mode:0o600}); }
    catch (error) { if (codeOf(error)!=='EEXIST') try { fs.unlinkSync(target); } catch { /* fail-open */ } throw error; }
  };
  if (exclusive) { create(file); return; }
  const temporary = path.join(path.dirname(file),`.tmp-${path.basename(file)}-${randomUUID().slice(0,8)}`);
  create(temporary);
  try {
    for (let attempt=0;;attempt++) {
      try { fs.renameSync(temporary,file); return; }
      catch (error) { if (attempt>=4 || !transientCodes.has(String(codeOf(error)))) throw error; pause(2*(attempt+1)); }
    }
  } catch (error) { try { fs.unlinkSync(temporary); } catch { /* fail-open */ } throw error; }
}
const leaseText = (leaseId: string): string => JSON.stringify({version:1,leaseId,observedAt:Date.now()});
/** Temp files only survive a crash between create and rename. `limit` bounds how many are examined (hooks sweep a few per claim). */
function sweepTemporary(dir: string, limit = Infinity): void {
  let examined = 0;
  for (const name of fs.readdirSync(dir)) if (name.startsWith('.tmp-')) {
    if (examined++ >= limit) return;
    try {
      const file = path.join(dir,name);
      if (Date.now()-fs.statSync(file).mtimeMs>60_000) fs.unlinkSync(file);
    } catch { /* fail-open */ }
  }
}

/** A dashboard-owned lease. Losing or stopping it never affects capture. */
export function enableRuntime(storage: string): { leaseId: string; stop(): void } {
  const leaseId = randomUUID();
  const file = path.join(storage,'runtime','observer.json');
  let stopped = false;
  try { fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700}); sweepTemporary(path.dirname(file)); writeSmall(file,leaseText(leaseId)); } catch { /* fail-open */ }
  const timer = setInterval(() => {
    if (stopped) return;
    try {
      let current: Lease | undefined;
      try { current = readSmall(file) as Lease; }
      catch (error) {
        // A transient read failure skips this beat; a vanished or corrupt (unparseable) file is rewritten.
        if (codeOf(error)==='ENOENT') fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
        else if (!(error instanceof SyntaxError)) return;
      }
      // Only another dashboard's lease is respected; unusable content in the file we own is replaced.
      const owner = current && typeof current==='object' ? current.leaseId : undefined;
      if (typeof owner==='string' && owner !== leaseId) return;
      writeSmall(file,leaseText(leaseId));
    } catch { /* No diagnostics retries in the host tool path. */ }
  },RUNTIME_LIMITS.heartbeatMs);
  timer.unref();
  return { leaseId, stop() {
    if (stopped) return;
    stopped = true; clearInterval(timer);
    try { if ((readSmall(file) as Lease).leaseId === leaseId) fs.unlinkSync(file); } catch { /* fail-open */ }
  } };
}

type OperationContext = { scope: RuntimeScope; fallbacks: Set<RuntimeKind> };

export class RuntimeObserver {
  readonly instanceId = randomUUID();
  private readonly context = new AsyncLocalStorage<OperationContext>();
  private state?: InstanceFile;
  private file?: string;
  private timer?: NodeJS.Timeout;
  private pending?: NodeJS.Timeout;
  private closed = false;
  private scope?: RuntimeScope;
  private revision?: string;
  private deniedUntil = 0;
  private leaseAt = 0;
  private leaseSeen?: Lease;
  private leaseOkAt = 0;
  private ownedAt = 0;
  private lastWrite = 0;
  private readonly leaseCacheMs: number;
  private readonly publishMs: number;
  constructor(private readonly storage: string, private readonly options: ObserverOptions = {}) {
    this.scope = cleanScope(options.scope); this.revision = identifier(options.configRevision);
    this.leaseCacheMs = options.leaseCacheMs ?? RUNTIME_LIMITS.leaseCacheMs;
    this.publishMs = options.publishMs ?? RUNTIME_LIMITS.publishMs;
    this.ensure();
    // The beat survives a missing lease so an idle long-lived process appears when a dashboard starts later.
    if (options.persistent !== false) { this.timer = setInterval(() => this.flush(),RUNTIME_LIMITS.heartbeatMs); this.timer.unref(); }
  }
  setScope(scope: RuntimeScope): void { this.scope = cleanScope(scope); if (this.state) this.state.scope = this.scope; this.publish(); }
  update(input: {configRevision?: string}): void {
    this.revision = identifier(input.configRevision); if (this.state) this.state.configRevision = this.revision; this.publish();
  }
  withScope<T>(scope: RuntimeScope, work: () => T): T {
    const safe = cleanScope(scope); return safe ? this.context.run({scope:safe,fallbacks:new Set()},work) : work();
  }
  /** Called only for the core's fixed fallback event names (never their fields); marks the enclosing operations of `kind`. */
  noteFallback(kind: RuntimeKind = 'score'): void { this.context.getStore()?.fallbacks.add(kind); }
  /** The lease is cached briefly; a failed read is "unknown" and keeps the last good lease until it would have expired. */
  private currentLease(fresh = false): Lease | undefined {
    const now = Date.now();
    if (!fresh && now-this.leaseAt<this.leaseCacheMs) return this.leaseSeen;
    this.leaseAt = now;
    const read = readLease(this.storage);
    if (read.lease) { this.leaseSeen = read.lease; this.leaseOkAt = now; }
    else if (read.definitive || now-this.leaseOkAt>=RUNTIME_LIMITS.leaseMs) this.leaseSeen = undefined;
    return this.leaseSeen;
  }
  private ensure(): boolean {
    if (this.closed || Date.now() < this.deniedUntil) return false;
    const current = this.currentLease();
    if (!current) { this.deniedUntil = Date.now()+250; return false; }
    if (this.state?.leaseId === current.leaseId && this.file) return true;
    const now = Date.now();
    const state: InstanceFile = {version:1,leaseId:current.leaseId,instanceId:this.instanceId,pid:process.pid,
      component:components.has(this.options.component ?? '') ? this.options.component! : 'manager',source:'runtime-file',
      startedAt:now,observedAt:now,scope:this.scope,configRevision:this.revision,activities:[],events:[],dropped:0};
    const file = this.claim(state,current,now);
    if (!file) { this.deniedUntil = now+1000; return false; }
    this.file = file; this.state = state; this.ownedAt = now; this.lastWrite = 0;
    return true;
  }
  /** One bounded probe: take a never-used slot, or reclaim a stopped/expired/previous-lease one in place. */
  private claim(state: InstanceFile, current: Lease, now: number): string | undefined {
    const encoded = JSON.stringify(state);
    const start = Number.parseInt(this.instanceId.slice(0,8),16) % RUNTIME_LIMITS.slots;
    // Bounds disk use without a dashboard restart: orphans from killed hooks are removed a few at a time.
    try { sweepTemporary(path.join(this.storage,'runtime'),8); } catch { /* fail-open */ }
    for (let n=0;n<RUNTIME_LIMITS.probes;n++) {
      const file = path.join(this.storage,'runtime',`slot-${String((start+n)%RUNTIME_LIMITS.slots).padStart(3,'0')}.json`);
      try {
        let old: InstanceFile | undefined, missing = false, unreadable = false;
        try { old = readSmall(file) as InstanceFile | undefined; unreadable = !old; }
        catch (error) { missing = codeOf(error)==='ENOENT'; unreadable = !missing; }
        if (unreadable) {
          // A crash can interrupt a diagnostics write. Reclaim it after the same stale interval, never a fresh partial write.
          const stat = fs.statSync(file);
          if (!stat.isFile() || now-stat.mtimeMs<RUNTIME_LIMITS.staleMs) continue;
        } else if (old && old.leaseId === current.leaseId && !old.stoppedAt && now-old.observedAt < RUNTIME_LIMITS.staleMs) continue;
        writeSmall(file,encoded,missing);
        // Two claimants can race for the same reclaimable slot; the last writer wins and the other keeps probing.
        if ((readSmall(file) as InstanceFile).instanceId !== this.instanceId) continue;
        return file;
      } catch { continue; }
    }
    return undefined;
  }
  /** Coalesces bursts: at most one write per publishMs, the rest ride an unref'd trailing timer. */
  private publish(): void {
    const wait = this.publishMs-(Date.now()-this.lastWrite);
    if (wait <= 0) { this.flush(); return; }
    if (!this.pending && !this.closed) { this.pending = setTimeout(() => { this.pending = undefined; this.flush(); },wait); this.pending.unref(); }
  }
  /** Writes the current state now (heartbeat, final write of a short-lived process). */
  flush(): void {
    if (this.pending) { clearTimeout(this.pending); this.pending = undefined; }
    this.lastWrite = Date.now();
    try {
      if (!this.ensure() || !this.state || !this.file) return;
      const now = Date.now();
      if (now-this.ownedAt >= this.leaseCacheMs) {
        // A stalled process must never resurrect metadata after its slot was recycled.
        if ((readSmall(this.file) as InstanceFile).instanceId !== this.instanceId) { this.file=undefined; this.state=undefined; return; }
        this.ownedAt = now;
      }
      this.state.observedAt = now; writeSmall(this.file,this.fit());
    } catch { /* Never expose or persist the raw filesystem error. */ }
  }
  /** Sheds oldest events, then oldest activities, until the file fits its documented bound. */
  private fit(): string {
    const state = this.state!;
    for (;;) {
      const encoded = JSON.stringify(state), size = Buffer.byteLength(encoded);
      if (size <= RUNTIME_LIMITS.fileBytes) return encoded;
      let excess = size-RUNTIME_LIMITS.fileBytes;
      while (excess > 0) {
        const list = state.events.length ? state.events : state.activities;
        if (!list.length) throw new Error('Runtime metadata bound exceeded');
        excess -= Buffer.byteLength(JSON.stringify(list.shift()))+1; state.dropped++;
      }
    }
  }
  /** A short-lived process cannot rely on a later timer, so its outermost operation end writes immediately. */
  private settle(): void {
    if (this.options.persistent === false && this.state && !this.state.activities.length) this.flush(); else this.publish();
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
          status:context?.fallbacks.has(activity.kind) && (!result.status || result.status==='ok') ? 'fallback' :
            statuses.has(result.status ?? '') ? result.status : 'ok'});
        this.settle();
      } catch { /* fail-open */ }
    };
  }
  private event(event: RuntimeEvent): void {
    if (!this.state) return;
    this.state.events.push(event);
    if (this.state.events.length>RUNTIME_LIMITS.events) {this.state.events.shift(); this.state.dropped++;}
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) {clearInterval(this.timer);this.timer=undefined;}
    if (this.pending) {clearTimeout(this.pending);this.pending=undefined;}
    try {
      if (!this.state || !this.file) return;
      // Closing an old instance cannot create a fresh-looking entry in a new lease. An unreadable or expired
      // lease says nothing about slot ownership, so the stopped marker is still attempted.
      const current = this.currentLease(true);
      if (current && current.leaseId !== this.state.leaseId) return;
      try { if ((readSmall(this.file) as InstanceFile).instanceId !== this.instanceId) return; }
      catch { /* Unknown ownership: reclaiming needs 15 s of silence, so this slot is still ours. */ }
      this.state.stoppedAt = this.state.observedAt = Date.now(); this.state.activities = [];
      writeSmall(this.file,this.fit());
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
