import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Publish complete files only. The previous file survives a failed write. */
export function atomicWrite(file: string, data: string | Buffer, mode = 0o600): void {
  publish(file, data, mode, true);
}

/** Publish a complete initial file without replacing a concurrent winner. */
export function atomicCreate(file: string, data: string | Buffer, mode = 0o600): boolean {
  return publish(file, data, mode, false);
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));
/** Windows refuses to replace a file another process briefly holds open (scanner, indexer, reader). */
function renameRetry(from: string, to: string): void {
  const deadline = Date.now() + 1000;
  for (let wait = 5; ; wait = Math.min(wait * 2, 100)) {
    try { renameSync(from, to); return; }
    catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '') || Date.now() >= deadline) throw error;
      Atomics.wait(sleeper, 0, 0, wait);
    }
  }
}

function publish(file: string, data: string | Buffer, mode: number, replace: boolean): boolean {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, 'wx', mode);
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (replace) renameRetry(tmp, file);
    else {
      // Both paths are on the same volume. A hard link publishes the complete,
      // fsynced inode atomically and refuses to overwrite an existing config.
      try { linkSync(tmp, file); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw error;
      }
    }
    // Directory fsync is supported on POSIX; Windows cannot open directories this way.
    if (process.platform !== 'win32') {
      let dir: number | undefined;
      try { dir = openSync(dirname(file), 'r'); fsyncSync(dir); }
      catch { /* Some filesystems do not support directory fsync. */ }
      finally { if (dir !== undefined) closeSync(dir); }
    }
    return true;
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(tmp); } catch { /* renamed or never created */ }
  }
}
