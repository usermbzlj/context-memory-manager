# Context Memory Manager

### Keep the evidence. Shrink the context. Recall the original.

A local-first tool-context memory layer for people who work with coding agents.
A long build log should not occupy every subsequent model request. A short summary
should not be the only surviving record of what happened.

CMM captures the observed tool input/result, verifies its archive, and gives supported
agent integrations a smaller view with a handle back to the original.

**No account. No mandatory API key. No runtime dependencies. No edits to your agent's binaries.**

[中文说明](README.zh-CN.md) · [Agent setup](docs/INTEGRATIONS.md) · [Operations](docs/OPERATIONS.md) · [Architecture](docs/ARCHITECTURE.md) · [What was actually tested](docs/RELEASE_VALIDATION.md)

> **0.2.0-rc.1 — release candidate, not live-agent certification.** Source, subprocess,
> protocol, migration and package tests run locally. Actual Windows/agent smoke tests
> are separate release gates. This is an archive + projection layer, not a universal
> interception proxy or a replacement for the host's native context management.

## See the complete loop

```text
Captured tool result     Agent-visible extract       Exact recall
177,046 characters  -->  7,950 characters        -->  177,046 characters
                         source handle + evidence     15 verified pages
                                                     SHA-256 matches
```

Those are reproducible **synthetic-demo character counts**, not measured API-token
savings, a task-quality benchmark, or a promise about your workload.

```sh
node dist/src/cli.js demo
```

The demo creates disposable local storage, captures a test log, projects it, finds it
through search, reassembles every page, checks SHA-256 and removes its temporary data.
It does not use your archive or call a model.

## Start with the shipped build

Requires **Node.js >=22.13**. Use Node, not Bun, to run the core. The release source ZIP
includes `dist/src`; it runs without installing npm dependencies.

```powershell
# Inside the extracted release directory:
node .\dist\src\cli.js demo

# Choose the project where you actually run the agent:
node .\dist\src\cli.js setup opencode --workspace "D:\MyProject" --dry-run
node .\dist\src\cli.js setup opencode --workspace "D:\MyProject"
```

Restart the agent. Review/approve its hooks and MCP tools when the host asks.
The installer preserves unrelated configuration and backs up changed existing files.
It never disables permission prompts or changes your model/provider settings.

The supplied `.tgz` is also installable locally:

```powershell
npm install -g .\context-memory-manager-0.2.0-rc.1.tgz --ignore-scripts --no-audit --no-fund
cmm demo
cmm setup claude --workspace "D:\MyProject" --dry-run
```

These are **local-artifact** instructions. No npm registry publication or GitHub repository
publication is claimed. A source checkout without `dist` needs `npm ci` and `npm run build`.

## What each integration actually does

| Integration | Captures observed tool data | Changes visible context | Retrieves evidence |
| --- | --- | --- | --- |
| **OpenCode plugin** | Completed text tool results | Historical completed text-result projection, using an experimental hook | Native memory tools |
| **Claude Code hook + MCP** | Post-tool input/result, plus reported failures | Large successful `Bash.stdout` only, using the documented shape-safe replacement | Memory MCP |
| **Codex hook + MCP** | Post-tool input/result | **Capture only**; never abuses `decision: block` as compression | Memory MCP |
| **Kimi launch wrapper + MCP** | Post-tool input/output or failure error | **Capture only**; no unsupported replacement field | Memory MCP |
| **MCP proxy** | Calls/results that pass through this one proxy | Eligible plain-text results only | Memory tools alongside upstream tools |
| **Memory MCP by itself** | **Does not observe native tools** | None | Already captured data |

The proxy preserves errors, structured content, tools with an output schema, images,
attachments and annotated content blocks. It does not intercept a client's other servers
or built-in tools. See the exact boundaries and primary-source references in
[Agent setup](docs/INTEGRATIONS.md).

## Use memory rather than an opaque summary

Five tools are exposed to the agent:

```text
context_search   Discover archived evidence, source handles and provenance
context_recall   Read verified original input/result pages
context_pin      Protect an event from future compatible projection and cleanup
context_unpin    Remove event-level pins, without deleting the archive
context_status  Inspect capture activity, configuration and projection receipts
```

Search indexes descriptors plus bounded input/head/tail evidence. It is intentionally
not an exhaustive full-text index or a semantic/vector search service. `context_recall`
uses event IDs, not ambiguous recycled tool-call IDs. It reports the hash, total size,
page boundaries and `nextOffset`. A partial recall does **not** flood the active context
by restoring the entire original result.

For exact edits, have the agent recall the relevant original. Historical tool output is
untrusted evidence, not a new system instruction or permission grant.

You can also inspect the archive directly:

```powershell
cmm status --agent opencode --workspace "D:\MyProject"
cmm search "test failure" --agent opencode --workspace "D:\MyProject"
cmm recall EVENT_ID --agent opencode --workspace "D:\MyProject" --limit 12000
cmm recall EVENT_ID --agent opencode --workspace "D:\MyProject" --out .\original.txt
cmm pin EVENT_ID --agent opencode --workspace "D:\MyProject"
cmm verify --agent opencode --workspace "D:\MyProject"
```

Exports are exact UTF-8 for the captured field and refuse to overwrite an existing file.
Scopes default to the configured agent + normalized workspace. `--shared` explicitly allows
cross-agent archive access **inside that workspace**, never an arbitrary workspace chosen
by a model tool argument. Cross-agent shared recall cannot use `restore`.

## Why this isn't just another summarizer

The archive is the source of truth. Original input/result hashes and source-session
provenance do not move when another session recalls an event. Small ordinary text uses
SQLite; large or NUL-containing text uses content-addressed blob files. Every projection
requires a successful, hash-verified archive read. Damaged, missing, changed or unsupported
results are kept rather than guessed at.

The core makes `KEEP / CAPSULE / EVICT` decisions under pressure. Pins, recent recall and
active work chains protect important evidence. Mutation-like tools and failed calls have
at least a capsule floor; fallback scoring never fully evicts. The default works locally;
optional model providers can refine scoring. Invalid model JSON is a provider failure,
not a fabricated successful score.

OpenCode uses a persistent **Node bridge**, so its Bun plugin does not load `node:sqlite`.
A new output is presented once before history projection, even when many tools complete
in one batch. The plugin changes only eligible `state.output` strings, not user messages,
assistant prose, tool arguments, attachments, transcript files or permissions.

## Reversible setup and local ownership

```powershell
cmm uninstall opencode --workspace "D:\MyProject" --dry-run
cmm uninstall opencode --workspace "D:\MyProject"
```

Uninstall removes only CMM-marked configuration; it does not delete the archive. Kimi
capture stops when you stop launching it through `cmm launch kimi`. Restart active agents
after installing, uninstalling, moving CMM, or changing its configuration.

Storage defaults to `~/.context-memory-manager`, overridable by `CMM_STORAGE` or `--storage`.
**Captured data may contain credentials or private source code and is not encrypted.**
Protect the directory and backups; do not commit them. Optional configured model providers
receive the descriptor/capsule data described in [Security and privacy](SECURITY.md).

Originals are retained indefinitely by default. Explicit retention caps plus `cmm gc --yes`
can delete eligible cold originals. `EVICT` means less visibility, not deletion. Never run
cleanup expecting deleted originals to remain recallable.

## Build and verify

```sh
npm ci --ignore-scripts
npm test
npm run test:pack
```

The package check installs the actual tarball into an isolated directory **offline**, then
runs help, the demo, setup/uninstall and an independent stdio MCP handshake. The repository
includes Linux/macOS/Windows Node 22/24 CI configuration; a checked-in workflow is not a
claim that those remote jobs have already run.

See [release validation](docs/RELEASE_VALIDATION.md) for exact local results, remaining live
checks, and intentionally unsupported behavior. Contributions should start from a real
failure or a demonstrated workflow improvement, not another generic platform layer.

MIT licensed. Runtime dependencies: none.
