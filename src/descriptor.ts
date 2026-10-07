/**
 * Descriptor extraction: deterministic, local summarisation of a tool
 * interaction. This is the "descriptor" layer of the intelligence stack:
 * everything here is cheap, local, and never invents facts (PRD §9).
 *
 * A descriptor is deliberately lossy-but-honest: it records what the tool
 * did (paths, exit codes, test verdicts, errors), never guesses intent.
 */

import type { EventStatus, ToolDescriptor } from './types.js';
import { truncateText } from './util/text.js';

/** ~4 chars per token, minimum 1. */
export function estimateTokens(text: string): number {
  let units = 0;
  for (const ch of text) units += ch.codePointAt(0)! < 128 ? 0.25 : 1;
  return Math.max(1, Math.ceil(units));
}

/**
 * Manager tools are internal: they are audit-logged only and excluded from
 * retention management (invariant: internal manager tools never managed).
 */
export const INTERNAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  'context_search',
  'context_recall',
  'context_pin',
  'context_unpin',
  'context_status',
  'context_stats',
  'context_doctor',
]);

/**
 * True for the known internal tool names, anything under the `context_`
 * prefix, and the MCP-namespaced equivalents (`mcp__context_memory__*`).
 */
export function isInternalTool(toolName: string): boolean {
  return (
    INTERNAL_TOOL_NAMES.has(toolName) ||
    toolName.startsWith('mcp__context_memory__') ||
    toolName.startsWith('mcp__context_memory_manager__')
  );
}

// ---------------------------------------------------------------------------
// Side-effect detection
// ---------------------------------------------------------------------------

/**
 * Heuristic: does this tool call mutate state?
 *
 * Name-based check (case-insensitive), in order:
 *  1. Guard: anything starting with 'read'/'red' (Read, readFile, redit, …)
 *     is excluded first, so Read-like tools never match via the substring
 *     check ('redit' contains 'edit' but is a read-family name).
 *  2. Exact match against known mutating tool names.
 *  3. The name contains 'write' / 'edit' / 'delete' / 'patch' / 'deploy'
 *     (covers e.g. `WriteFile`, `apply_patch`, `gitDeleteBranch`).
 *
 * Shell check: for bash-like tools (name in {bash, shell, exec,
 * run_command, …} or an input whose first line looks like a shell command)
 * the first 400 chars of input are scanned for mutating verbs (rm,
 * git commit/push, npm publish, sed -i, …). The name list and the
 * "looks like a shell command" test are deliberately narrow to avoid
 * flagging prose that merely mentions commands.
 */
const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set([
  'write',
  'edit',
  'multiedit',
  'notebookedit',
  'applypatch',
  'delete',
  'removefile',
  'create',
  'createfile',
  'mkdir',
  'deploy',
  'publish',
  'commit',
  'patch',
]);

const MUTATING_SUBSTRINGS = ['write', 'edit', 'delete', 'patch', 'deploy'];

const SHELL_TOOL_NAMES: ReadonlySet<string> = new Set([
  'bash',
  'shell',
  'exec',
  'exec_command',
  'run_shell_command',
  'shell_command',
  'run_command',
  'sh',
  'zsh',
  'powershell',
  'cmd',
  'terminal',
]);

const MUTATING_SHELL_VERBS =
  /\b(rm|mv|mkdir|rmdir|cp\s+.*\s+\/|git\s+(commit|push|merge|rebase|reset|checkout\s+-b)|npm\s+publish|yarn\s+publish|docker\s+(rm|rmi|push|build)|kubectl\s+(apply|delete|create)|terraform\s+apply|sed\s+-i|chmod|chown|kill|pkill|shutdown|reboot|deploy)\b/i;

/** First non-empty line of the input that starts with a common command. */
const SHELL_LIKE_INPUT =
  /^(?:sudo\s+)?(?:rm|mv|cp|mkdir|rmdir|git|npm|npx|yarn|pnpm|bun|docker|kubectl|terraform|sed|chmod|chown|kill|pkill|shutdown|reboot|make|cargo|go|python|pip|apt|brew|rsync|scp|tar|touch|echo|cat|ls|find|grep|awk|curl|wget|vim|nano|code)\b/i;

function firstNonEmptyLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function isBashLike(toolName: string, input: string): boolean {
  const name = toolName.toLowerCase();
  return (
    SHELL_TOOL_NAMES.has(name) ||
    SHELL_LIKE_INPUT.test(firstNonEmptyLine(input))
  );
}

/** A conservative hint, never proof of absence of effects. */
export function isSideEffectTool(toolName: string, input: string): boolean {
  const name = toolName.toLowerCase();
  if (MUTATING_TOOL_NAMES.has(name) || MUTATING_SUBSTRINGS.some(s => name.includes(s))) {
    if (!name.startsWith('read') && !name.startsWith('red')) return true;
  }
  if (name.startsWith('read') || name.startsWith('red')) return false;
  let command = input;
  try {
    const value = JSON.parse(input);
    if (value && typeof value === 'object') command = value.command ?? value.cmd ?? input;
  } catch { /* Plain text is a normal input format. */ }
  if (typeof command !== 'string') return true;
  if (isBashLike(toolName, command)) {
    // Shell composition, substitutions and redirection invalidate read-only guesses.
    if (/[;&|><`\n\r]/.test(command) || command.includes('$(')) return true;
    if (MUTATING_SHELL_VERBS.test(command)) return true;
    return !/^\s*(?:echo|pwd|ls|cat|head|tail|wc|rg|grep|stat|whoami|git\s+(?:status|diff|log|show))\b/.test(command);
  }
  return !/^(?:glob|grep|search|list|fetch|webfetch|web_search|find|lookup)(?:$|[_A-Z])/i.test(toolName);
}

// ---------------------------------------------------------------------------
// Salient-line extraction
// ---------------------------------------------------------------------------

const ERROR_LINE_RE = /error|exception|traceback|failed|fail\b|✗|panic/i;
/** Skip lines like "0 errors" — the absence of errors is not an error. */
const ZERO_ERRORS_RE = /0\s+errors?/i;
const PASSED_FAILED_RE = /(\d+)\s+passed[^\n]*?(\d+)\s+failed/i;
const TESTS_FAILED_RE = /tests?:\s*(\d+)\s+failed/i;
const FAILED_PASSED_RE = /(\d+)\s+failed[^\n]*?(\d+)\s+passed/i;
const BARE_FAIL_RE = /\bFAIL\b/;
const EXIT_CODE_RE = /exit\s*code\s*:?\s*(\d+)/i;
const URL_RE = /https?:\/\/\S+/;

/**
 * Path-like tokens. Greedy (not lazy): `src/a.test.ts` must come out whole,
 * not truncated to `src/a.test`. Version numbers (1.2.3) are filtered
 * separately by isPlausiblePath.
 */
const PATH_TOKEN_RE = /([A-Za-z0-9_@\-./\\]+\.[A-Za-z0-9]{1,6})/g;

function isPlausiblePath(token: string): boolean {
  // Version numbers (1.2.3) are not paths.
  if (/^\d+(\.\d+)+$/.test(token)) return false;
  return token.includes('/') || token.includes('\\') || token.includes('.');
}

function extractPathTokens(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(PATH_TOKEN_RE)) {
    const token = m[1].replace(/[.,;:!?)]+$/, '');
    if (!token || seen.has(token) || !isPlausiblePath(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

function truncate(text: string, maxChars: number): string {
  return truncateText(text, maxChars);
}

interface ResultScan {
  salient: string[];
  pathTokens: string[];
  exitCode?: number;
  testVerdict?: string;
  hasErrors: boolean;
}

function scanResult(result: string): ResultScan {
  // Scan head AND tail: test runners often put the only verdict at the end.
  const all = result.split('\n');
  const lines = all.length <= 4000 ? all : [...all.slice(0, 2000), ...all.slice(-2000)];
  const errorLines: string[] = [];
  const otherLines: string[] = [];
  const pathSet = new Map<string, true>();
  let exitCode: number | undefined;
  let testVerdict: string | undefined;
  let hasErrors = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const isErrorLine =
      ERROR_LINE_RE.test(line) && !ZERO_ERRORS_RE.test(line);
    if (isErrorLine) hasErrors = true;

    let verdict: string | undefined;
    const pf = PASSED_FAILED_RE.exec(line);
    if (pf) {
      verdict = `${pf[1]} passed, ${pf[2]} failed`;
    } else {
      const reverse=FAILED_PASSED_RE.exec(line);
      if(reverse)verdict=`${reverse[2]} passed, ${reverse[1]} failed`;
      const tf = TESTS_FAILED_RE.exec(line);
      if (tf) verdict = `${tf[1]} failed`;
      else if (BARE_FAIL_RE.test(line)) verdict = 'FAIL';
    }
    if (verdict !== undefined) {
      testVerdict = verdict;
    }

    {
      const em = EXIT_CODE_RE.exec(line);
      if (em) exitCode = Number(em[1]);
    }

    const linePaths = extractPathTokens(line);
    for (const token of linePaths) {
      if (!pathSet.has(token)) pathSet.set(token, true);
    }

    const isSalient =
      isErrorLine ||
      verdict !== undefined ||
      EXIT_CODE_RE.test(line) ||
      URL_RE.test(line) ||
      linePaths.length > 0;
    if (isSalient) {
      const trimmed = truncate(line, 160);
      if (isErrorLine) errorLines.push(trimmed);
      else otherLines.push(trimmed);
    }
  }

  // Errors first, then everything else; dedup; cap at 12.
  const salient = [...new Set([...errorLines, ...otherLines])].slice(0, 12);
  return {
    salient,
    pathTokens: [...pathSet.keys()],
    exitCode,
    testVerdict,
    hasErrors,
  };
}

// ---------------------------------------------------------------------------
// buildDescriptor
// ---------------------------------------------------------------------------

function buildInputSummary(
  toolName: string,
  input: string,
  bashLike: boolean,
): string {
  if (bashLike) return truncate(firstNonEmptyLine(input), 120);
  const lower = toolName.toLowerCase();
  if (lower.includes('read')) {
    const target = extractPathTokens(input)[0] ?? firstNonEmptyLine(input);
    return truncate(`Read ${target}`, 120);
  }
  if (lower.includes('edit') || lower.includes('write')) {
    const target = extractPathTokens(input)[0] ?? firstNonEmptyLine(input);
    return truncate(`${toolName} ${target}`, 120);
  }
  return truncate(firstNonEmptyLine(input), 120);
}

export function buildDescriptor(
  toolName: string,
  input: string,
  result: string,
  status: EventStatus,
): ToolDescriptor {
  let evidence = result;
  let command = input;
  try {
    const parsed = JSON.parse(result);
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.stdout === 'string') evidence = parsed.stdout + '\n' + (parsed.stderr ?? '') +
        (typeof (parsed.exit_code ?? parsed.exitCode) === 'number' ? `\nexit code: ${parsed.exit_code ?? parsed.exitCode}` : '');
      else if (Array.isArray(parsed.content)) evidence = parsed.content.filter((p: {type?: string}) => p.type === 'text').map((p: {text?: string}) => p.text ?? '').join('\n');
    }
  } catch { /* Text result. */ }
  try { const parsed = JSON.parse(input); if (typeof parsed?.command === 'string') command = parsed.command; else if (typeof parsed?.cmd === 'string') command = parsed.cmd; } catch { /* Text input. */ }
  const scan = scanResult(evidence);
  const bashLike = isBashLike(toolName, input);
  const paths = [
    ...new Set([...extractPathTokens(input), ...scan.pathTokens]),
  ].slice(0, 20);

  let outcome: string | undefined;
  if (
    scan.testVerdict !== undefined &&
    /([1-9]\d*\s+failed|^FAIL$)/.test(scan.testVerdict)
  ) {
    outcome = 'test failure';
  } else if (status === 'error' && scan.hasErrors) {
    outcome = 'error';
  } else if (
    scan.testVerdict !== undefined &&
    /0\s+failed/.test(scan.testVerdict)
  ) {
    outcome = 'success';
  }

  return {
    tool: toolName,
    status,
    sizeChars: input.length + result.length,
    tokenEstimate: estimateTokens(input) + estimateTokens(result),
    inputSummary: buildInputSummary(toolName, command, bashLike),
    salient: scan.salient,
    paths,
    ...(scan.exitCode !== undefined ? { exitCode: scan.exitCode } : {}),
    ...(scan.testVerdict !== undefined
      ? { testVerdict: scan.testVerdict }
      : {}),
    ...(outcome !== undefined ? { outcome } : {}),
    isSideEffect: isSideEffectTool(toolName, input),
  };
}
