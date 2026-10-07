/**
 * Shared helpers for the surface-layer test suite.
 *
 * Every test gets a brand-new manager on a fresh mkdtemp storage root, so
 * tests are fully isolated from each other (and from any real user data).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ContextManager } from '../src/core/context-manager.js';
import { JevScorer } from '../src/scoring/jev.js';
import { FakeProvider } from '../src/providers/fake.js';
import { rowToToolEvent } from '../src/types.js';
import { normalizeWorkspaceId } from '../src/storage/archive.js';
import type { ToolEvent, ToolEventInput } from '../src/types.js';

let toolCallCounter = 0;
type ResourceCleanup = () => void | Promise<void>;
const resources = new WeakMap<ContextManager,ResourceCleanup[]>();

/** Close child processes/other resources before the manager and storage. */
export function registerCleanup(manager:ContextManager,close:ResourceCleanup):void {
  const registered=resources.get(manager) ?? [];
  registered.push(close);resources.set(manager,registered);
}

/** Every cleanup is attempted even if an earlier resource reports a failure. */
export async function cleanupAll(...actions:ResourceCleanup[]):Promise<void> {
  const errors:unknown[]=[];
  for(const action of actions)try{await action();}catch(error){errors.push(error);}
  if(errors.length===1)throw errors[0];
  if(errors.length>1)throw new AggregateError(errors,'Multiple resources failed to clean up');
}

/** Fresh manager on a fresh temp storage dir. */
export async function makeManager(
  overrides: Record<string, unknown> = {},
): Promise<{ manager: ContextManager; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-test-'));
  // Disable file logging in tests: the JSONL stream opens lazily and would
  // otherwise race the temp-dir cleanup in afterEach.
  const manager = ContextManager.open(dir, { logging: { dir: null }, ...overrides });
  return { manager, dir };
}

/** Deterministic sample tool event; override any field via `partial`. */
export function sampleInput(partial: Partial<ToolEventInput> = {}): ToolEventInput {
  toolCallCounter += 1;
  return {
    agent: 'test-agent',
    workspaceId: '/test/ws',
    sessionId: 's1',
    toolCallId: `tc-${toolCallCounter}`,
    toolName: 'Bash',
    input: 'echo hi',
    result: 'hi',
    status: 'ok',
    ...partial,
  };
}

/** Close the manager and remove its temp storage dir. */
export async function cleanup(dir: string, manager: ContextManager): Promise<void> {
  const registered=resources.get(manager) ?? [];
  resources.delete(manager);
  await cleanupAll(...registered.reverse(),()=>manager.close(),()=>{fs.rmSync(dir,{recursive:true,force:true});});
}

/**
 * Fetch a tool event by tool_call_id. Agent/workspace default to the
 * sampleInput() defaults; override for cross-agent tests.
 */
export function getEventByCallId(
  manager: ContextManager,
  toolCallId: string,
  agent = 'test-agent',
  workspaceId = '/test/ws',
): ToolEvent | undefined {
  const row = manager.db.getToolEventByCallId(agent, normalizeWorkspaceId(workspaceId), toolCallId);
  return row ? rowToToolEvent(row) : undefined;
}

/**
 * Install a JevScorer backed by a FakeProvider as the manager's primary
 * retention scorer, wired to log provider calls into the manager's DB.
 * `failTimes > 0` makes the provider fail, exercising the conservative
 * fallback path.
 */
export function useJevPrimary(
  manager: ContextManager,
  cannedText: string,
  failTimes = 0,
): void {
  const fake = new FakeProvider('test-fake', cannedText, { failTimes });
  manager.retention.primary = new JevScorer({
    providers: [fake],
    recordCall: (r) => manager.db.insertProviderCall(r),
    logger: manager.logger,
  });
}

/** Report near-total host usage so the next maybeTidy() actually evaluates. */
export function pressured(manager: ContextManager, sessionId: string): void {
  manager.reportHostUsage(sessionId, { contextWindow: 1000, usedTokens: 999 });
}
