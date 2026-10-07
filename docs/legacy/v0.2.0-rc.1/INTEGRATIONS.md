# Agent integrations and their boundaries

Interfaces were checked against official documentation/source on **2026-09-21**.
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

`tool.execute.after` observes recognized text outputs. The experimental
`chat.messages.transform` hook captures missed completed text parts, evaluates pressure and
replaces eligible historical `state.output` strings. User messages, assistant prose, tool
inputs, pending/error states, attachments and transcript files are untouched. Newly observed
results are shown once before they can be projected. Some MCP paths have a different after-hook
shape; unrecognized shapes are skipped, not coerced into a guessed result.

The plugin communicates with a persistent Node subprocess using a private, bounded JSONL
protocol. Its own five memory tools use the same bridge. Scope uses the actual worktree or,
for OpenCode's non-git `/` sentinel, the current project directory. A non-git project must
not become a global-root archive shared with every other non-git project.

**Limits:** the transform API is experimental; host changes may require a revised adapter.
The plugin factory and actual Node bridge were exercised under Node, not a live OpenCode/Bun
session. Context usage is estimated from visible messages plus the reported model limit,
not measured provider billing. Very large outputs may exceed the 32 MiB bridge frame bound;
those remain unchanged. Native host compaction still exists and is not disabled.

## Claude Code: native capture and bounded Bash replacement

```powershell
cmm setup claude --workspace "D:\MyProject" --dry-run
cmm setup claude --workspace "D:\MyProject"
```

This merges `.claude/settings.local.json` hooks and the `.mcp.json` server entry.
`PostToolUse` and `PostToolUseFailure` capture the values that the host delivers.
Only a successful `Bash` result with documented `stdout`, `stderr`, `interrupted: false`
and `isImage: false` fields is eligible for replacement. CMM replaces only `stdout`, retains
all other fields, and emits `hookSpecificOutput.updatedToolOutput` with the original shape.
Unknown/structured/image results and failures do not emit replacements.

A candidate must be larger than `integration.maxOutputChars`, durably archived, hash-verified
and meaningfully shorter. No hook blocks or approval policy changes are used. Standard output
is empty on a capture-only or failure path. Standard error may contain a short diagnosis.

**Limits:** this is ingress compression, not arbitrary historical-message editing. Pinning a
result does not rewrite a request already sent to Claude. `context_recall` retrieves its
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

## Kimi: temporary launch configuration, not a global config rewrite

```powershell
cmm launch kimi --workspace "D:\MyProject"
# Preserve your alternate source configuration:
cmm launch kimi --workspace "D:\MyProject" --config-file "D:\Config\kimi.toml" -- --help
```

The wrapper copies the existing config into a private temporary sibling, preserving its
relative path base, and adds two capture hooks. It adds a temporary memory MCP config and
retains the default global MCP config when present. It launches your existing `kimi`
executable with the requested arguments, then removes temporary files on normal exit.
It never adds YOLO/AFK flags or bypasses tool approval.

The hooks read `tool_output` on success and `error` on failure. The documented post-hook
contract does not guarantee a tool-call ID. Missing IDs become unique observation IDs;
CMM does not pretend that two otherwise identical outputs are the same invocation.
Native hooks are silent, capture-only. No unsupported output replacement is attempted.

`cmm setup kimi` writes a project MCP definition for inspection/manual use; **that file
alone does not install native hooks**. `cmm launch kimi` is the supported capture path.
TOML `[[hooks]]` and JSON hook arrays are supported; ambiguous inline TOML hook arrays
are refused rather than overwritten. Existing global servers named `context_memory`
must be renamed/removed before the scoped wrapper can safely add its server.

**Limits:** Kimi documents hooks as Beta. A hard kill or power loss can leave a temporary
`.cmm-launch-*` file beside the original config; it may contain copied credentials.
Remove stale files only after the associated process has stopped. On Windows, shell paths
with unsafe command metacharacters are refused; choose an ordinary path. The wrapper does
not rewrite the agent or resolve an incompatible host version automatically.

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
are archived and projected; errors, output-schema tools, structured content, images and
annotated text retain their original result structure. Unknown shapes fail open. Memory tool
names are reserved; a conflicting upstream name produces an explicit error.

This is **not** a general MCP transport gateway. It implements a deliberately bounded,
tools-only stdio subset, negotiating `2024-11-05`, `2025-03-26` or `2025-06-18`.
There is no Streamable HTTP/SSE, resource/prompt passthrough, roots, sampling, elicitation,
server-initiated capability forwarding or latest-protocol compliance claim. Use the upstream
directly when those capabilities are required. There are at most eight concurrent inbound
requests, 32 MiB per frame, and 100 tool-list pages.

## Primary references

- OpenCode plugin contract: https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/plugin/src/index.ts
- OpenCode tool factory: https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/plugin/src/tool.ts
- OpenCode non-git worktree handling: https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/project/project.ts
- Claude hooks / replacement shape: https://code.claude.com/docs/en/hooks
- Codex hooks and code-mode behavior: https://learn.chatgpt.com/docs/hooks
- Codex MCP setup: https://developers.openai.com/codex/mcp/
- Kimi Beta hooks: https://moonshotai.github.io/kimi-cli/en/customization/hooks.html
- Kimi CLI config flags: https://moonshotai.github.io/kimi-cli/en/reference/kimi-command.html
- MCP stdio transport: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports

These references are contracts, not a claim that a particular installed version was tested.
