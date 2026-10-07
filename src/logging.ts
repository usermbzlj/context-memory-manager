import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from './types.js';

/** Metadata only. Archives are private; log files must not become another transcript. */
export function redact(value: unknown, key = ''): unknown {
  if (/api.?key|authorization|password|secret|credential|inputSummary|raw(Input|Result)/i.test(key)) return '[redacted]';
  if (typeof value === 'string') return value.replace(/\b(?:sk|sess)-[\w-]{12,}/g, '[redacted]')
    .replace(/(Bearer\s+)\S+/gi, '$1[redacted]').slice(0, 2000);
  if (Array.isArray(value)) return value.slice(0, 32).map(v => redact(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,redact(v,k)]));
  return value;
}

export function createLogger(opts: {dir?: string | null; level?: 'debug'|'info'|'warn'|'error'} = {}): Logger {
  const threshold = {debug:0,info:1,warn:2,error:3}[opts.level ?? 'info'];
  let closed = false;
  const file = opts.dir ? path.join(opts.dir, 'events.jsonl') : undefined;
  const make = (base: Record<string, unknown>): Logger => ({
    log(event, fields = {}) {
      if (closed) return;
      const severity = /failed|failure|corrupt/i.test(event) ? 'error' : /fallback|skipped/i.test(event) ? 'warn' : 'info';
      if ({debug:0,info:1,warn:2,error:3}[severity] < threshold) return;
      const line = JSON.stringify(redact({ts:new Date().toISOString(),level:severity,event,...base,...fields})) + '\n';
      if (file) {
        try {
          fs.mkdirSync(path.dirname(file), {recursive:true});
          if (fs.existsSync(file) && fs.statSync(file).size > 10 * 1024 * 1024) fs.renameSync(file,file+'.1');
          fs.appendFileSync(file,line,{mode:0o600});
        } catch { /* Diagnostics must never break a tool call or change its output. */ }
      }
      if (process.env.CMM_DEBUG === '1') process.stderr.write(line);
    },
    child(extra) {return make({...base,...extra});},
    close() {closed=true;},
  });
  return make({});
}
