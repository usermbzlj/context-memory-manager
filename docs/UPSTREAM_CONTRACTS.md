# Upstream contracts and audit provenance

Reviewed for this revision: 2026-10-02; host and MCP contracts re-checked 2026-10-07; OpenCode 2.x added 2026-10-10. These are implementation references, not live-host
certification, benchmark results or a claim that every mentioned integration was retested against
every current upstream binary. Public documentation can change independently of a tagged release.

## RTK recovery format

Pinned source: `rtk-ai/rtk`, tag `v0.50.0`, `src/core/retriever.rs`.
Git blob SHA returned by the source connector: `046ecde9f929caaadfa7a7c2661b369ccc4ded2e`.
https://github.com/rtk-ai/rtk/blob/v0.50.0/src/core/retriever.rs

The source's `store_inner` determines the adapter contract: hash is the first 12 hexadecimal
characters of SHA-256 of filter command bytes, one NUL byte, and the full input bytes. The SQLite
`byte_size` is the original size even when the stored BLOB is partial. Oversized successful
outputs can store the hidden tail, not the prefix; a truncated row's full hash is not reconstructible
from its BLOB. `raw` and `gzip` are storage codecs, not completeness guarantees.

CMM checks the actual required column set, bounds decompression, checks original digest/length
only when untruncated, preserves original metadata, and stores its own full SHA-256. It does not
copy source implementation, require RTK to run, update RTK counters, or execute recovery commands.
Tests construct independent fixtures using this format, including bad hashes, truncated hidden
tails, invalid UTF-8, malformed gzip, mixed scopes and CLI dry-run. A real RTK binary was not
available for execution in this environment. New RTK schemas/codecs must be deliberately reviewed.

## Historical transform and prompt caching

https://opencode.ai/docs/plugins/
https://github.com/anomalyco/opencode/blob/dev/packages/plugin/src/index.ts
https://platform.claude.com/docs/en/build-with-claude/prompt-caching

OpenCode's experimental history transform permits mutation at a request boundary; this is not a
stable all-agent message-editing API. Current message serialization is used only for estimated
pressure. CMM never describes its local transform result as provider consumption acknowledgement.
The caching documentation requires exact prefix matches; hence a stable projection cache and
batch cooldown are engineering mitigations, not proof of cost improvements. Test exact cache
usage and outcomes in real long tasks before selecting aggressive settings.

## Claude, Codex, Kimi and MCP

Re-checked 2026-10-07. Versions named here are what the contracts were read against, not
installed binaries that were exercised.

https://code.claude.com/docs/en/hooks
https://code.claude.com/docs/zh-CN/hooks
https://developers.openai.com/codex/mcp/
https://learn.chatgpt.com/docs/hooks
https://github.com/MoonshotAI/kimi-code/tree/%40moonshot-ai/kimi-code%402.1.1
https://modelcontextprotocol.io/specification/2026-07-28/basic/lifecycle
https://modelcontextprotocol.io/specification/2025-11-25/basic/transports

The reviewed Claude contract allows a shape-preserving `updatedToolOutput` and an exec-form
command handler (`command` plus `args`, no shell). CMM uses only the successful documented Bash
envelope when the user explicitly enables ingress projection. This is not history editing.
Codex (docs current with `rust-v0.160.1`) and Kimi native adapters remain capture-only by
design; this is a CMM capability statement, not a claim that every possible upstream hook
technique is impossible.

Kimi Code 2.1.1 (`packages/agent-core-v2/src/features/externalHooks`) reads `[[hooks]]` only from
`$KIMI_CODE_HOME/config.toml`, accepts `event`, `matcher`, `command` and `timeout`, runs the
command through a shell in the session directory, and sends `tool_output` as the first 2,000
UTF-16 units of text parts. It has no per-launch config flag, which retired the old wrapper.

OpenCode 1.18.35 still exposes `tool.execute.after` and `experimental.chat.messages.transform`.

## OpenCode 2.x plugin API

Pinned source: `anomalyco/opencode`, tag `v2.0.26` (commit `9b4ec5714d48`), read 2026-10-10.
- **Module shape:** `packages/core/src/plugin/module.ts` decodes the default export as
  `{ id, setup }` or `{ id, effect }` and rejects a function, so 1.x plugin files do not load.
- **Promise context:** `packages/plugin/src/promise/` gives `location`, `tool.transform`,
  `tool.hook("execute.after")`, `tool.list`, `session.hook("context")` and `model.list`. Hook
  callbacks run inside `Effect.promise`, so a rejected callback is a host defect, not an ignored error.
- **Tool results:** `packages/core/src/tool/runtime.ts` defines the visible content
  (`normalizeContent`/`stringify`). A tool without an output schema must not return `output`. JSON
  Schema inputs are accepted.
- **Code mode:** in `packages/core/src/tool.ts`, tools without `codemode: false` are reachable only
  through `execute`. Inner calls reuse the `execute` call context and its ID
  (`packages/core/src/codemode/tool.ts`).
- **Request messages:** `packages/core/src/session/runner/to-llm-message.ts` lowers a completed
  result with exactly one text part to `tool-result.result = {type:"text"}`. Locally executed results
  live in `role:"tool"` messages, and provider-executed results stay inside assistant content.
- **Request hook:** `packages/core/src/session/model-request.ts` passes the hook's `messages` into the
  request it builds; requests are rebuilt from persisted history for each step.
- **Workspace:** `packages/core/src/project.ts` resolves `project.directory` to the git worktree, the
  hg root or the directory itself.
- **Plugin files:** global plugins load from `plugin/` or `plugins/` in
  `OPENCODE_CONFIG_DIR`/`$XDG_CONFIG_HOME/opencode`.

MCP support is tools-only stdio. Legacy clients negotiate 2024-11-05 through 2025-11-25 with
`initialize`. The memory server also implements the stateless 2026-07-28 surface it needs:
`server/discover`, per-request `_meta` protocol version, `resultType`, list cache hints and the
`-32022` unsupported-version error. The proxy speaks only the legacy handshake upstream.
No assertion of full-spec conformance is made.
