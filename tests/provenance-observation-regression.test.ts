import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryService } from '../src/runtime/memory.js';
import { mergeObservedProvenance, type EvidenceProvenance } from '../src/evidence/provenance.js';
import { createOpenCodePlugin, type OpenCodeToolFactory } from '../src/integrations/opencode.js';
import { makeManager, cleanup } from './util.js';

const raw = 'captured evidence without a truncation marker\n'.repeat(4000);
const partial: EvidenceProvenance = {
  version: 1, origin: 'tool-observation', captureStage: 'host-result',
  completeness: 'partial', notes: ['Host reported metadata.truncated=true.'],
};
async function fixture(t: TestContext) {
  const { manager, dir } = await makeManager();
  t.after(() => cleanup(dir, manager));
  return { manager, dir, service: new MemoryService(manager, { agent: 'opencode', workspaceId: dir }) };
}

test('duplicate observations add partial restrictions without replacing originals or identities', async t => {
  const { manager, service } = await fixture(t);
  const input = { sessionId: 's', toolCallId: 'c', toolName: 'Read', input: 'log.txt', result: raw };
  const first = await service.capture(input);
  manager.db.updateToolEvent(first.eventId!, { state: 'capsule', protected_until_turn: 0 });
  const compact = await service.project(first.eventId!, raw, 'history', 's');
  assert.equal(compact.replaced, true);
  const source = manager.db.getToolEvent(first.eventId!)!;
  assert.equal((await service.capture({ ...input, provenance: partial })).eventId, first.eventId);
  assert.equal(service.explain(first.eventId!).provenance.completeness, 'partial');
  assert.equal(service.explain(first.eventId!).provenance.captureStage, 'unknown');
  assert.deepEqual(manager.db.getToolEvent(first.eventId!), source);
  assert.equal((await manager.archive.fetchOriginal(first.eventId!)).result, raw);
  const restored = await service.project(first.eventId!, compact.text, 'history', 's');
  assert.equal(restored.text, raw);
  assert.equal(restored.reason, 'incomplete-source');
  await service.capture(input);
  assert.equal(service.explain(first.eventId!).provenance.completeness, 'partial');
});

test('conflicting duplicate content cannot alter source provenance', async t => {
  const { service } = await fixture(t);
  const input = { sessionId: 's', toolCallId: 'c', toolName: 'Read', input: 'x', result: raw };
  const first = await service.capture(input);
  const conflicting = await service.capture({ ...input, result: 'different', provenance: partial });
  assert.equal(conflicting.archived, false);
  assert.equal(service.explain(first.eventId!).provenance.completeness, 'unknown');
});

test('new observations cannot upgrade completeness or replace imported source identity', () => {
  const stored: EvidenceProvenance = { version: 1, origin: 'rtk-recall', captureStage: 'rtk-store',
    completeness: 'partial', notes: ['original source'], upstream: { system: 'rtk', sourceDigest: 'a'.repeat(64) } };
  const claimedComplete: EvidenceProvenance = { ...partial, completeness: 'complete' };
  assert.deepEqual(mergeObservedProvenance(stored, claimedComplete), stored);
  const filtered: EvidenceProvenance = { ...partial, origin: 'upstream-filtered', upstream: { system: 'rtk', reference: 'b'.repeat(12) } };
  assert.deepEqual(mergeObservedProvenance(stored, filtered), stored);
  const unknown: EvidenceProvenance = { ...partial, completeness: 'unknown', notes: ['first observation'] };
  assert.equal(mergeObservedProvenance(unknown, claimedComplete).completeness, 'unknown');
  const restricted = mergeObservedProvenance(unknown, filtered);
  assert.equal(restricted.origin, 'upstream-filtered');
  assert.equal(restricted.completeness, 'partial');
  assert.deepEqual(mergeObservedProvenance(restricted, unknown), restricted);
});

function toolFactory(): OpenCodeToolFactory {
  const node: any = { optional: () => node, int: () => node, min: () => node, max: () => node };
  const tool: any = (value: unknown) => value;
  tool.schema = { string: () => node, number: () => node, boolean: () => node, enum: () => node };
  return tool;
}

test('OpenCode cached after-hook observations learn late truncation metadata and retain first presentation', async t => {
  const { manager, service, dir } = await fixture(t);
  const calls: string[] = [];
  const bridge = {
    async request(method: string, params: any): Promise<any> {
      calls.push(method);
      if (method === 'capture') return service.capture(params, 'opencode');
      if (method === 'observeProvenance') return service.observeProvenance(params);
      if (method === 'transform') return service.transform(params.sessionId, params.items, params.usage);
      throw new Error(`Unexpected bridge method ${method}`);
    }, close() {},
  };
  const plugin = await createOpenCodePlugin({ directory: dir }, { node: process.execPath, cli: '', storage: dir, tool: toolFactory(), bridge });
  t.after(() => plugin.dispose());
  await plugin['chat.params']({ sessionID: 's', model: { limit: { context: 10000 } } });
  await plugin['tool.execute.after']({ tool: 'Read', sessionID: 's', callID: 'c', args: 'log.txt' }, { output: raw });
  const id = service.lookup('s', 'c', 'Read')!.eventId;
  manager.db.updateToolEvent(id, { state: 'capsule', protected_until_turn: 0 });
  const messages: any[] = [{ info: { role: 'assistant', sessionID: 's' }, parts: [{ type: 'tool', tool: 'Read', callID: 'c',
    state: { status: 'completed', input: 'log.txt', output: raw, metadata: { truncated: true } } }] }];
  await plugin['experimental.chat.messages.transform']({}, { messages });
  assert.equal(service.explain(id).provenance.completeness, 'partial');
  await plugin['experimental.chat.messages.transform']({}, { messages });
  assert.equal(messages[0].parts[0].state.output, raw);
  assert.equal(manager.db.queryOne<{ n: number }>('SELECT count(*) n FROM projection_cache')!.n, 0);
  assert.equal(calls.filter(method => method === 'capture').length, 1);
  assert.equal(calls.filter(method => method === 'observeProvenance').length, 1);
});

test('late OpenCode truncation on a recognized cached projection restores the source without recapturing marker bytes', async t => {
  const { manager, service, dir } = await fixture(t);
  const input = { sessionId: 's', toolCallId: 'c', toolName: 'Read', input: 'log.txt', result: raw };
  const id = (await service.capture(input)).eventId!;
  manager.db.updateToolEvent(id, { state: 'capsule', protected_until_turn: 0 });
  const projected = await service.project(id, raw, 'history', 's');
  assert.equal(projected.replaced, true);
  let captures = 0;
  const bridge = {
    async request(method: string, params: any): Promise<any> {
      if (method === 'lookup') return service.lookup(params.sessionId, params.toolCallId, params.toolName);
      if (method === 'capture') { captures++; return service.capture(params, 'opencode'); }
      if (method === 'observeProvenance') return service.observeProvenance(params);
      if (method === 'transform') return service.transform(params.sessionId, params.items, params.usage);
      throw new Error(`Unexpected bridge method ${method}`);
    }, close() {},
  };
  const plugin = await createOpenCodePlugin({ directory: dir }, { node: process.execPath, cli: '', storage: dir, tool: toolFactory(), bridge });
  t.after(() => plugin.dispose());
  const messages: any[] = [{ info: { role: 'assistant', sessionID: 's' }, parts: [{ type: 'tool', tool: 'Read', callID: 'c',
    state: { status: 'completed', input: 'log.txt', output: projected.text, metadata: { truncated: true } } }] }];
  await plugin['experimental.chat.messages.transform']({}, { messages });
  assert.equal(messages[0].parts[0].state.output, raw);
  assert.equal(captures, 0);
  assert.equal(service.explain(id).provenance.completeness, 'partial');
  assert.equal((await manager.archive.fetchOriginal(id)).result, raw);
  assert.equal(service.search().results.length, 1);
});

test('restriction observations reject spoofed markers, wrong invocation scope, receipt corruption and completeness upgrades', async t => {
  const { manager, service, dir } = await fixture(t);
  const id = (await service.capture({ sessionId: 's', toolCallId: 'c', toolName: 'Read', input: 'log.txt', result: raw })).eventId!;
  manager.db.updateToolEvent(id, { state: 'capsule', protected_until_turn: 0 });
  const projected = await service.project(id, raw, 'history', 's');
  const observation = { sessionId: 's', toolCallId: 'c', toolName: 'Read', output: projected.text, provenance: partial };
  await assert.rejects(() => service.observeProvenance({ ...observation, output: projected.text + 'spoof' }), /recognized projection/);
  for (const changed of [{ sessionId: 'other' }, { toolCallId: 'other' }, { toolName: 'Bash' }])
    await assert.rejects(() => service.observeProvenance({ ...observation, ...changed }), /source invocation/);
  for (const scope of [{ agent: 'other', workspaceId: dir }, { agent: 'opencode', workspaceId: dir + '-other' }]) {
    const foreign = new MemoryService(manager, scope);
    await assert.rejects(() => foreign.observeProvenance(observation), /source invocation/);
  }
  await assert.rejects(() => service.observeProvenance({ ...observation, provenance: { ...partial, completeness: 'complete' } }), /only add/);
  manager.db.run('UPDATE projection_cache SET visible_sha=? WHERE event_id=?', ['0'.repeat(64), id]);
  await assert.rejects(() => service.observeProvenance(observation), /integrity mismatch/);
  assert.equal(service.explain(id).provenance.completeness, 'unknown');
});

test('restriction observation cannot republish provenance retired during the verified source read', async t => {
  const { manager, service } = await fixture(t);
  manager.config.storage.maxSizeBytes = 1;
  const id = (await service.capture({ sessionId: 's', toolCallId: 'c', toolName: 'Read', input: 'x', result: raw })).eventId!;
  manager.db.updateToolEvent(id, { state: 'evicted', protected_until_turn: 0 });
  const fetch = manager.archive.fetchOriginal.bind(manager.archive);
  manager.archive.fetchOriginal = async eventId => {
    const original = await fetch(eventId);
    assert.equal((await manager.gc()).deletedEvents, 1);
    return original;
  };
  await assert.rejects(() => service.observeProvenance({ sessionId: 's', toolCallId: 'c', toolName: 'Read', output: raw, provenance: partial }), /not available/);
  assert.equal(manager.db.queryOne('SELECT event_id FROM evidence_provenance WHERE event_id=?', [id]), undefined);
});
