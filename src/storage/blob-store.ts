/** Content-addressed UTF-8 archive. All reads, including inline rows, are verified. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import * as path from 'node:path';
import type { ContentRef } from '../types.js';
import { atomicWrite } from '../util/atomic.js';
import { utf8 } from '../util/validation.js';

export function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}
export class BlobStore {
  private readonly rootDir: string;
  constructor(rootDir: string, private readonly thresholdBytes: number) {
    mkdirSync(rootDir, { recursive: true });
    this.rootDir = realpathSync(rootDir);
  }
  put(text: string): ContentRef {
    utf8(text, 'archive content');
    const bytes = Buffer.byteLength(text, 'utf8');
    const hash = sha256(text);
    // Some Node/SQLite versions truncate embedded NUL in returned TEXT values.
    // Keep those payloads in exact byte-backed blobs, even when small.
    if (bytes <= this.thresholdBytes && !text.includes('\0')) return { kind: 'inline', ref: text, sha256: hash, bytes };
    const ref = `${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
    const entry: ContentRef = { kind: 'blob', ref, sha256: hash, bytes };
    const file = this.blobFilePath(entry);
    mkdirSync(path.dirname(file), { recursive: true });
    this.assertInside(path.dirname(file));
    if (!existsSync(file)) atomicWrite(file, text);
    // An existing hash-named file is not proof of durability or correctness.
    this.get(entry);
    return entry;
  }
  get(ref: ContentRef): string {
    if (ref.kind === 'inline') utf8(ref.ref, 'inline archive content');
    const bytes = ref.kind === 'inline' ? Buffer.from(ref.ref, 'utf8') : readFileSync(this.blobFilePath(ref));
    const actual = sha256(bytes);
    if (actual !== ref.sha256 || bytes.length !== ref.bytes) {
      throw new Error(`archive integrity mismatch: expected ${ref.sha256}, got ${actual}`);
    }
    // Verify the actual disk bytes before decoding. A replacement decoder could
    // turn corrupt 0xff into a legitimate U+FFFD and accidentally pass a text hash.
    return new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(bytes);
  }
  private assertInside(file: string): void {
    if (!existsSync(file)) return;
    const resolved = realpathSync(file);
    const relative = path.relative(this.rootDir, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('blob path escapes archive root');
    if (lstatSync(file).isSymbolicLink()) throw new Error('symlinked blob paths are not supported');
  }
  blobFilePath(ref: ContentRef): string {
    if (ref.kind !== 'blob') throw new Error('expected a blob reference');
    if (!/^[a-f0-9]{64}$/.test(ref.sha256)) throw new Error('invalid blob hash');
    const canonical = `${ref.sha256.slice(0, 2)}/${ref.sha256.slice(2, 4)}/${ref.sha256}`;
    if (ref.ref !== canonical) throw new Error('non-canonical blob reference');
    const file = path.join(this.rootDir, ...canonical.split('/'));
    this.assertInside(path.dirname(file));
    this.assertInside(file);
    return file;
  }
  deleteBlob(ref: string): boolean {
    const hash = ref.split('/').at(-1) ?? '';
    const file = this.blobFilePath({ kind: 'blob', ref, sha256: hash, bytes: 0 });
    try { unlinkSync(file); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
}
