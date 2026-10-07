/**
 * PRD §24: path-like relative and absolute forms resolve to one workspace
 * row. Bare opaque IDs remain distinct from paths. '~' expands to home.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { normalizeWorkspaceId } from '../src/storage/archive.js';
import {
  makeManager,
  sampleInput,
  cleanup,
} from './util.js';
import type { ContextManager } from '../src/core/context-manager.js';

function expectedNativePath(value: string): string {
  return process.platform === 'win32' ? value.replace(/^([A-Z]):/, (_, drive: string) => `${drive.toLowerCase()}:`) : value;
}

describe('workspace id normalization', () => {
  it('unit: opaque, relative, and home forms normalize correctly', () => {
    // Opaque ids (agent names, UUIDs) pass through unchanged.
    assert.equal(normalizeWorkspaceId('ws'), 'ws');
    assert.equal(normalizeWorkspaceId('550e8400-e29b-41d4-a716-446655440000'), '550e8400-e29b-41d4-a716-446655440000');
    // Relative paths resolve against the cwd.
    assert.equal(
      normalizeWorkspaceId('./rel/ws'),
      expectedNativePath(path.resolve('./rel/ws')),
    );
    assert.equal(normalizeWorkspaceId('rel/ws'), expectedNativePath(path.resolve('rel/ws')));
    // Home expansion.
    assert.equal(
      normalizeWorkspaceId('~/proj'),
      expectedNativePath(path.join(os.homedir(), 'proj')),
    );
  });

  describe('end to end', () => {
    let manager: ContextManager;
    let dir: string;

    beforeEach(async () => {
      ({ manager, dir } = await makeManager());
    });

    afterEach(async () => {
      await cleanup(dir, manager);
    });

    it('relative and absolute workspace ids share one workspace row', async () => {
      // Note: a bare name with no path characters is an opaque id by design;
      // use a slash-containing relative path for the path-like case.
      const rel = 'cmm-test/rel-ws';
      const abs = path.resolve(rel);
      await manager.recordToolComplete(
        sampleInput({ toolCallId: 'ws-rel', workspaceId: rel }),
      );
      await manager.recordToolComplete(
        sampleInput({ toolCallId: 'ws-abs', workspaceId: abs }),
      );

      const workspaces = manager.db.queryAll<{ id: string }>(
        'SELECT id FROM workspaces',
      );
      assert.equal(workspaces.length, 1);
      assert.equal(workspaces[0].id, expectedNativePath(abs));

      // Lookup works with either form (manager APIs normalize on entry).
      const viaRel = await manager.recall('ws-rel', 'test-agent', rel);
      assert.equal(viaRel.toolCallId, 'ws-rel');
      const viaAbs = await manager.recall('ws-abs', 'test-agent', abs);
      assert.equal(viaAbs.toolCallId, 'ws-abs');
    });

    it('duplicate detection survives path-form differences', async () => {
      const rel = './cmm-test/dup-ws';
      const first = await manager.recordToolComplete(
        sampleInput({ toolCallId: 'dup-ws', workspaceId: rel }),
      );
      const second = await manager.recordToolComplete(
        sampleInput({ toolCallId: 'dup-ws', workspaceId: path.resolve(rel) }),
      );
      assert.equal(second.eventId, first.eventId);
    });
  });
});
