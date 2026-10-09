import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { defaultConfig, loadConfig, saveConfig } from '../src/config.js';
import type { Config } from '../src/types.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmm-config-save-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const cfg = defaultConfig(dir);
  saveConfig(cfg);
  return { dir, cfg, file: path.join(dir, 'config.json') };
}
function run(dir: string, ...args: string[]) {
  return spawnSync(process.execPath, [cli, 'config', ...args, '--storage', dir], { encoding: 'utf8', timeout: 10000 });
}

test('CLI rejects configuration replacements that would prevent the next reopen, without changing bytes', t => {
  const { dir, cfg, file } = fixture(t);
  const before = fs.readFileSync(file);
  const replacements: [string, unknown][] = [
    ['strategies', { ...cfg.strategies, surprise: cfg.strategies.balanced }],
    ['integration', { ...cfg.integration, surprise: true }],
    ['retention', { scorer: 'conservative', surprise: true }],
    ['logging', { ...cfg.logging, surprise: true }],
    ['models', { cheapModel: null, surprise: true }],
    ['strategies', { balanced: cfg.strategies.balanced }],
    ['models', {}],
    ['models.cheapModel', 42],
  ];
  for (const [key, value] of replacements) {
    const result = run(dir, 'set', key, JSON.stringify(value));
    assert.equal(result.status, 1, `${key}: ${result.stderr}`);
    assert.deepEqual(fs.readFileSync(file), before, `Rejected ${key} must preserve existing bytes`);
    assert.equal(run(dir, 'show').status, 0, 'The previous configuration remains usable');
  }
  const accepted = run(dir, 'set', 'integration.captureOnly', 'true');
  assert.equal(accepted.status, 0, accepted.stderr);
  const reopened = run(dir, 'show');
  assert.equal(reopened.status, 0, reopened.stderr);
  assert.equal(JSON.parse(reopened.stdout).integration.captureOnly, true);
  assert.equal(loadConfig(dir).integration.captureOnly, true);
});

test('direct configuration saves reject incomplete or unknown nested fields before replacing a file', t => {
  const { cfg, file } = fixture(t);
  const before = fs.readFileSync(file);
  const invalid: Record<string, any>[] = [
    { ...cfg, providers: { ...cfg.providers, surprise: [] } },
    { ...cfg, providers: { ...cfg.providers, retention: [{ kind: 'fake', name: 'fixture', model: 'fixture', surprise: true }] } },
    { ...cfg, strategies: { ...cfg.strategies, balanced: { ...cfg.strategies.balanced, surprise: true } } },
    { ...cfg, strategies: { ...cfg.strategies, balanced: { trigger: 0.65, release: 0.48 } } },
    { ...cfg, integration: { captureOnly: true } },
    { ...cfg, storage: { ...cfg.storage, path: null } },
    { ...cfg, models: null },
  ];
  for (const replacement of invalid) {
    assert.throws(() => saveConfig(replacement as Config));
    assert.deepEqual(fs.readFileSync(file), before);
  }
  const missing = structuredClone(cfg) as Partial<Config>;
  delete missing.models;
  assert.throws(() => saveConfig(missing as Config), /missing config key/);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('partial older disk configurations still receive defaults and unsafe or inherited keys remain refused', t => {
  const { dir, file } = fixture(t);
  fs.writeFileSync(file, JSON.stringify({ integration: { captureOnly: true } }));
  const upgraded = loadConfig(dir);
  assert.equal(upgraded.integration.captureOnly, true);
  assert.equal(upgraded.integration.ingressCompression, false);
  saveConfig(upgraded);
  assert.deepEqual(loadConfig(dir), upgraded);
  for (const key of ['surprise', 'toString', '__proto__', 'constructor', 'prototype']) {
    const bytes = JSON.stringify({ [key]: {} });
    fs.writeFileSync(file, bytes);
    assert.throws(() => loadConfig(dir), /unknown config key|unsafe config key/);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'Invalid disk configuration is never reset');
  }
});
