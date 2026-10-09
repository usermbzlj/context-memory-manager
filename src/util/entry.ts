import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * True when this module is the process entry point. The ESM loader reports the real path, while
 * argv keeps any symlinked spelling (macOS /var -> /private/var, npm links, nvm/Homebrew layouts).
 */
export function isEntryPoint(moduleUrl: string): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  const self = fileURLToPath(moduleUrl);
  if (path.resolve(invoked) === self) return true;
  try { return fs.realpathSync(invoked) === fs.realpathSync(self); } catch { return false; }
}
