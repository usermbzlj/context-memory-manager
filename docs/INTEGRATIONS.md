# Agent integrations and their boundaries

Contracts were re-checked on **2026-10-07** against OpenCode 1.18.35 plugin source, the current
Claude Code hooks reference, Codex hooks/MCP docs, Kimi Code 2.1.1 source and MCP 2026-07-28.
See `UPSTREAM_CONTRACTS.md` for source provenance and live-test limitations.
An adapter test verifies our interpretation of a contract; it does not certify a live host.
Use an installed release tarball (`cmm`) or substitute `node /absolute/path/dist/src/cli.js`.
Run setup from the project root or give `--workspace` explicitly.

## OpenCode: historical text-result projection

```powershell
cmm setup opencode --workspace "D:\MyProject" --dry-run
cmm setup opencode --workspace "D:\MyProject"
```

This writes a marked `.opencode/plugins/context-memory-manager.ts`. The generated file
imports the host's `tool` factory and the installed CMM plugin by an absolute file URL.
It retains the Node executable path used by setup. Re-run setup after moving the installation
or switching Node installations. The host provides `@opencode-ai/plugin`; CMM does not install
another copy or edit the OpenCode executable.

`tool.execute.after` observes recognized text outputs. The
`experimental.chat.messages.transform` hook captures missed completed text parts, evaluates pressure and
replaces eligible historical `state.output` strings. User messages, assistant prose, tool
inputs, pending/error states, attachments and transcript files are untouched. Newly observed
results are shown once before they can be projected. Some MCP paths have a different after-hook
shape; unrecognized shapes are skipped, not coerced into a guessed result.
An explicit `metadata.truncated=true` marks the captured output as partial in both hooks.
The captured bytes remain exact; partial output is never projected again, including when an
RTK hint is also present. Absence of a truncation flag does not prove completeness.

The plugin communicates with a persistent Node subprocess using a private, bounded JSONL
protocol. Its own five memory tools use the same bridge. Scope uses the actual worktree or,
for OpenCode's non-git `/` sentinel, the current project directory. A non-git project must
not become a global-root archive shared with every other non-git project.
Plugin disposal is awaitable and idempotent. It waits for the Node bridge and its streams to
close before storage can be removed; pending requests fail without upstream retries.

**Limits:** the transform API is experimental; host changes may require a revised adapter.
The plugin factory and actual Node bridge were exercised under Node, not a live OpenCode/Bun
session. Context usage is estimated from visible messages with the reported model limit when available,
not measured provider billing. Very large outputs may exceed the 32 MiB bridge frame bound;
those remain unchanged. Native host compaction still exists and is not disabled.

## Claude Code: native capture; explicit opt-in Bash ingress replacement

```powershell
cmm setup claude --workspace "D:\MyProject" --dry-run
cmm setup claude --workspace "D:\MyProject"
```

This merges `.claude/settings.local.json` hooks and the `.mcp.json` server entry.
`PostToolUse` and `PostToolUseFailure` capture the values that the host delivers.
Hooks use Claude's **exec form** (`command` is the absolute Node executable, `args` holds the CLI
path and options), so no Git Bash or PowerShell quoting applies and install paths may contain
spaces or shell metacharacters. A Claude Code release that predates exec form ignores `args`;
use a current release. Re-running setup replaces an earlier shell-form CMM hook.
**Default is capture-only output behavior.** Set `integration.ingressCompression=true`
explicitly to enable this ingress path, then restart the host. Only a successful `Bash` result with documented `stdout`, `stderr`, `interrupted: false`
and `isImage: false` fields is eligible for replacement. CMM replaces only `stdout`, retains
all other fields, and emits `hookSpecificOutput.updatedToolOutput` with the original shape.
Unknown/structured/image results and failures do not emit replacements.

A candidate must be larger than `integration.maxOutputChars`, durably archived, hash-verified
and meaningfully shorter. No hook blocks or approval policy changes are used. Standard output
is empty on a capture-only or failure path. Standard error may contain a short diagnosis.

**Limits:** this is ingress compression, not arbitrary historical-message editing. Pinning a
result does not rewrite a request already sent to Claude. On Windows, wherever Claude's
PowerShell tool is enabled it handles shell commands; those results are captured but never
replaced, because only the documented Bash envelope is eligible. `context_recall` retrieves its
captured envelope; the original tool may have been truncated before the hook observed it.
The hook does not make invisible/pre-truncation output magically recoverable.

## Codex: capture-only native hooks, exact recall through MCP

```powershell
cmm setup codex --workspace "D:\MyProject" --dry-run
cmm setup codex --workspace "D:\MyProject"
```

This merges `.codex/hooks.json` and a marked `[mcp_servers.context_memory]` block in
`.codex/config.toml`. Review the project trust/hook approval flow in Codex, including `/hooks`
when required. CMM never grants trust or changes sandbox/approval settings for you.

Current official docs expose `PostToolUse` with `tool_input`, `tool_response` and
`tool_use_id`; the hook also runs for a completed shell command with a nonzero exit.
Native CMM emits no stdout and does not change the result. It captures observable output
and exposes search/recall through MCP.

Codex's `decision: block` can replace a completed result with hook feedback and reject nested
code-mode calls. That is not a transparent compression API. CMM does not use it, does not
claim native history rewriting, and does not set unsupported replacement fields. Hosted tools
outside the documented hook coverage cannot be observed by this adapter.

For actual compression of calls to a particular external MCP server, configure that server
through the tools-only proxy below. Native tools remain outside that proxy.

## Kimi Code 2.x: user-level capture hooks, project MCP

```powershell
cmm setup kimi --workspace "D:\MyProject" --dry-run
cmm setup kimi --workspace "D:\MyProject"
```

Kimi Code reads hooks only from its user-level `config.toml` in `KIMI_CODE_HOME` (default
`~/.kimi-code`) and has no per-launch config flag. Setup therefore adds two `[[hooks]]` tables
(`PostToolUse`, `PostToolUseFailure`) for this workspace to that file, backs up the previous
file beside it, and writes `.kimi-code/mcp.json` in the project. Each workspace has its own
tables; uninstall removes only that workspace's tables and MCP entry. CMM identifies its tables
by the `--managed-by-cmm` command, not by comments, so a Kimi rewrite that drops comments is
still recognized. Hooks in another form (an inline `hooks = [...]` array) are refused rather
than rewritten. Run `kimi` once first; setup refuses to create a missing config. `setup all`
reports Kimi as skipped in that case.

Because the hooks are user-level, they run in every project. A hook whose working directory
is outside the configured workspace exits silently without opening the archive. Each
configured workspace adds one short Node process per tool call; Kimi does not wait for these
observation-only hooks, so a `context_search` issued immediately after a tool call can miss
that call until its capture finishes. A non-zero `Bash` exit arrives as `PostToolUseFailure`.

Kimi delivers `tool_call_id`, the tool input and `tool_output` on success, and an error object
on failure. **`tool_output` is at most the first 2,000 UTF-16 units of the text output.** An
output of that length is recorded as `partial` evidence and is never projected again; a
dangling surrogate at the cut is dropped so the observed prefix is valid UTF-8. Shorter outputs
were not cut by the hook. Native hooks are silent, capture-only. No output replacement is
attempted and no approval mode is changed.

Kimi loads MCP servers from the user `mcp.json`, then the git root `.mcp.json` (shared with
Claude), then `<cwd>/.kimi-code/mcp.json`; later entries override earlier ones. Start Kimi from
the workspace root so the Kimi-scoped `context_memory` server applies, and approve workspace
trust when asked.

**Limits:** `cmm launch kimi` from earlier releases targeted the archived Python `kimi-cli` and
was removed; Kimi Code 2.x rejects its flags. Setup backups in `KIMI_CODE_HOME` can contain
provider credentials from your config; keep or delete them as you would the original. Windows
hook commands with command metacharacters in their paths are refused; choose an ordinary path.
The installed Kimi Code 2.1.1 binary was exercised with an isolated home and a scripted local
model (see `RELEASE_VALIDATION.md`); a real model session and the interactive trust prompt were not.
## Tools-only MCP proxy

Start a stdio server through CMM instead of connecting to that one server directly:

```text
cmm proxy --agent codex --workspace D:\MyProject -- node D:\Tools\my-mcp-server.js
```

In the host's MCP config, set `command` to the absolute Node executable and `args` to
`[absoluteCmmCli, "proxy", "--agent", "codex", "--workspace", project,
  "--", originalCommand, ...originalArgs]`. Preserve your existing environment variables.
Do not install the same upstream twice or recursively point the proxy at itself.

The proxy forwards each `tools/call` exactly once. A lost response, timeout or cancellation
is not retried. It cannot undo already-completed side effects. Eligible ordinary text results
are archived. Projection additionally requires `integration.ingressCompression=true` and the
upstream tool declaration `annotations.readOnlyHint=true`; unknown/mutation-like tools are not
projected. This annotation never bypasses permissions. In all modes, errors, output-schema tools, structured content, images and
annotated text retain their original result structure. Unknown shapes fail open. Memory tool
names are reserved; a conflicting upstream name produces an explicit error.

This is **not** a general MCP transport gateway. It implements a deliberately bounded,
tools-only stdio subset. Clients negotiate `2024-11-05` through `2025-11-25` with `initialize`;
the proxy uses the same handshake upstream. The built-in memory server (`cmm mcp`) also answers
stateless `2026-07-28` requests: `server/discover`, and `tools/list`/`tools/call` carrying the
protocol version in `_meta`. A proxy does not offer the stateless revision to its clients.
There is no Streamable HTTP/SSE, resource/prompt passthrough, roots, sampling, elicitation,
server-initiated capability forwarding or latest-protocol compliance claim. Use the upstream
directly when those capabilities are required. There are at most eight concurrent inbound
requests, 32 MiB per frame, and 100 tool-list pages.

## RTK coexistence

No RTK hooks, shell commands, permission settings or executable are installed by CMM. Recognizable
filtered results are captured but not shortened again. An explicit local `import-rtk` command can
copy a same-project recall record; optional `integration.rtkDatabasePath` lets capture attempt
that copy for a recognized hint. The source connection is read-only; imported evidence remains
separate and linked only as an unverified hint. An unavailable store does not break host output.
Schema compatibility is pinned, not a promise about all RTK versions. See `UPSTREAM_CONTRACTS.md`.

## Primary references

- OpenCode plugin contract: https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/plugin/src/index.ts
- OpenCode tool factory: https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/plugin/src/tool.ts
- OpenCode non-git worktree handling: https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/project/project.ts
- Claude hooks / replacement shape: https://code.claude.com/docs/en/hooks
- Codex hooks and code-mode behavior: https://learn.chatgpt.com/docs/hooks
- Codex MCP setup: https://developers.openai.com/codex/mcp/
- Kimi Code hooks: https://github.com/MoonshotAI/kimi-code/blob/%40moonshot-ai/kimi-code%402.1.1/docs/en/customization/hooks.md
- Kimi Code hook payloads: https://github.com/MoonshotAI/kimi-code/blob/%40moonshot-ai/kimi-code%402.1.1/packages/agent-core-v2/src/features/externalHooks/agent/agentExternalHooksService.ts
- MCP 2026-07-28 lifecycle: https://modelcontextprotocol.io/specification/2026-07-28/basic/lifecycle
- MCP stdio transport: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports

These references are contracts, not a claim that a particular installed version was tested.
