import * as fs from 'node:fs';

// Windows reports a file briefly held by another process (e.g. an antivirus scan) as EPERM/EBUSY.
// Node 24's rmSync throws at once on Windows instead of honouring maxRetries, so retry here.
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY', 'EMFILE', 'ENFILE']);
const sleeper = new Int32Array(new SharedArrayBuffer(4));

/** Remove a test's temporary directory, waiting up to about 5.5 s for transient locks. */
export function removeDir(dir: string): void {
  for (let attempt = 1; ; attempt++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch (error) {
      if (attempt > 10 || !TRANSIENT.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
      Atomics.wait(sleeper, 0, 0, 100 * attempt);
    }
  }
}
