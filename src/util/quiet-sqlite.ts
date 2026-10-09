// Must be the first import of an entry point: Node 22 emits this warning while `node:sqlite`
// loads, and hooks must leave the host's stderr empty. Every other warning still prints.
const emit = process.emitWarning.bind(process) as (...args: unknown[]) => void;
process.emitWarning = ((warning: unknown, ...rest: unknown[]) => {
  const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: unknown } | undefined)?.type;
  const name = warning instanceof Error ? warning.name : type;
  if (name === 'ExperimentalWarning' && /\bSQLite\b/.test(String(warning instanceof Error ? warning.message : warning))) return;
  emit(warning, ...rest);
}) as typeof process.emitWarning;
export {};
