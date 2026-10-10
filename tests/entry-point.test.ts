import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {VERSION} from '../src/version.js';
import {removeDir} from './remove-dir.js';

const srcDir=path.dirname(fileURLToPath(new URL('../src/cli.js',import.meta.url)));

test('the CLI and demo run when launched through a symlinked directory (macOS /var, npm links)',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cmm-entry-'));t.after(()=>removeDir(dir));
  const link=path.join(dir,'linked src');
  // Directory junctions need no Windows developer mode, unlike file symlinks.
  fs.symlinkSync(srcDir,link,process.platform==='win32'?'junction':'dir');
  const version=spawnSync(process.execPath,[path.join(link,'cli.js'),'--version'],{encoding:'utf8'});
  assert.equal(version.status,0,version.stderr);assert.equal(version.stdout.trim(),VERSION);
  const help=spawnSync(process.execPath,[path.join(link,'cli.js'),'--help'],{encoding:'utf8'});
  assert.match(help.stdout,/Keep the evidence/);
});

test('hook processes leave stderr free of the node:sqlite experimental warning',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cmm-quiet-'));t.after(()=>removeDir(dir));
  const probe=spawnSync(process.execPath,['--input-type=module','-e',
    `await import(${JSON.stringify(new URL('../src/util/quiet-sqlite.js',import.meta.url).href)});process.emitWarning('SQLite is an experimental feature and might change at any time','ExperimentalWarning');process.emitWarning('kept warning','ExperimentalWarning');await import('node:sqlite');`],{encoding:'utf8'});
  assert.equal(probe.status,0,probe.stderr);
  assert.doesNotMatch(probe.stderr,/SQLite is an experimental feature/);
  assert.match(probe.stderr,/kept warning/,'unrelated warnings still print');
});

test('a finished demo still succeeds when Windows briefly refuses to remove its disposable storage',()=>{
  const demo=spawnSync(process.execPath,['--input-type=module','-e',
    `import fs from 'node:fs';const rm=fs.rmSync;fs.rmSync=(p,o)=>{if(String(p).includes('cmm-demo-')){fs.rmSync=rm;throw Object.assign(new Error('busy'),{code:'EPERM'});}return rm(p,o);};
     const {runDemo}=await import(${JSON.stringify(new URL('../src/demo.js',import.meta.url).href)});await runDemo();`],{encoding:'utf8'});
  const left=/Demo storage was not removed \(EPERM\): (.+)/.exec(demo.stderr)?.[1]?.trim();
  if(left)removeDir(left);
  assert.equal(demo.status,0,demo.stderr);
  assert.equal(JSON.parse(demo.stdout).exactRecallVerified,true);
  assert.ok(left?.includes('cmm-demo-'),demo.stderr);
});
