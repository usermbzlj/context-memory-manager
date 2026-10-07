export function object(value: unknown, label = 'value'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
export function text(value: unknown, label: string, max = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw new Error(`${label} must be a nonempty string of at most ${max} characters (no NUL)`);
  }
  return value;
}
export function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer in [${min}, ${max}]`);
  }
  return value;
}
export function utf8(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  if (!value.isWellFormed()) throw new Error(`${label} contains an unpaired Unicode surrogate`);
}
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b, 'en')));
    }
    return v;
  });
}
export function errorMessage(error: unknown): string {
  // V8 JSON SyntaxError messages can quote private source text.
  if (error instanceof SyntaxError) return 'Invalid JSON or syntax (source content omitted)';
  return error instanceof Error ? error.message : String(error);
}
/** Text displayed by a CLI must not execute ANSI control sequences from tool logs. */
export function terminalSafe(value: unknown): string {
  return String(value ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
}
