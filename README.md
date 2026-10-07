# Context Memory Manager

**Keep the evidence. Release old tool context only when it is worth doing.**

[Chinese guide](README.zh-CN.md) | [Integrations](docs/INTEGRATIONS.md) | [Operations](docs/OPERATIONS.md) | [Validation](docs/RELEASE_VALIDATION.md)

CMM is a local evidence archive and a pressure-triggered history layer for coding agents.
It preserves captured tool results, makes the middle of long logs searchable, and returns
exact evidence on demand. With a compatible host, old results can leave the working context
without deleting the archive. It is not another collection of command-output filters.

**0.3.0-rc.1 is a release candidate.** Windows source, CLI and offline package checks pass;
live agent/Bun sessions and task-level cost or quality improvements are not certified.
No runtime npm dependencies, account, required model key, telemetry service or hosted database.

## Try it without changing an agent

Requires **Node.js >=22.13** (Windows checks use 24.19.0; the historical Linux run used 22.16.0). Extract the source-with-build ZIP
and run from its project directory:

```powershell
node .\dist\src\cli.js demo
```

The demo uses a disposable temporary archive, no API calls and no personal configuration.
It checks first-use preservation, a low-pressure no-op, a pressure-triggered batch, stable
projection bytes, middle-of-log search, complete paged recovery and pin restoration.

The provided local npm tarball can alternatively be installed without contacting a registry:

```powershell
npm install -g --offline --ignore-scripts .\context-memory-manager-0.3.0-rc.1.tgz
cmm demo
```

The package is supplied locally; these instructions do not imply an npm publication.
Node may print its experimental SQLite warning to stderr. Protocol stdout remains JSON only.

## Connect one project

OpenCode is the historical-projection integration:

```powershell
node .\dist\src\cli.js setup opencode --workspace "D:\MyProject" --dry-run
node .\dist\src\cli.js setup opencode --workspace "D:\MyProject"
```

Restart the host and follow its normal trust prompts. Setup records absolute CMM/Node paths;
keep this directory in place. Re-run setup after moving it. Use the same agent, workspace and
storage for search and diagnostics. CLI's default agent is `cli`, not your last-used host.

| Integration | Default behavior | Optional behavior / important boundary |
| --- | --- | --- |
| OpenCode | Capture, first-presentation protection, pressure-triggered historical text projection | Experimental host transform API; Node bridge, not native Bun SQLite |
| Claude Code | Capture + MCP retrieval; original first result unchanged | Explicit opt-in for a shape-preserving, successful Bash stdout ingress projection |
| Codex | Capture + MCP retrieval | No native CMM history or result rewriting |
| Kimi Code | Launch wrapper installs temporary capture hooks + MCP retrieval | `setup kimi` alone is not native capture; hooks are Beta |
| External tools-only MCP proxy | Forward once, archive eligible text, preserve original result | Opt-in projection only for declared read-only tools with eligible plain text |

The five tools are `context_search`, `context_recall`, `context_pin`, `context_unpin`, and
`context_status`. Installing only a memory MCP server does **not** observe native tools.
See [exact contracts and commands](docs/INTEGRATIONS.md).

## How history is handled

```text
observed output -> exact byte archive + provenance + searchable chunks
                        |
                 first use stays intact
                        |
          current host request reaches pressure threshold
                        |
       verify current results / protect pins, recalls, active work
                        |
          publish one worthwhile batch of stable text views
                        |
                 search -> exact bounded recall
```

Balanced mode triggers at estimated 65% context use and targets 48%. Those are policy inputs,
not a measurement of provider tokenization. Only tool results actually present in this host
request count as candidates. New batches need at least 2,048 characters of projected savings
and normally wait three observed tool turns between batches; critical 95% pressure can bypass
the cooldown. A batch examines at most 24 eligible results, newest first to avoid unnecessarily
editing older prefixes. Protected or unsuitable evidence can prevent reaching the target.

A persisted projection is bound to its event, session, representation, original hash and exact
output hash. Repeated requests reuse the same bytes, even after reopening. A CMM-looking prefix
is not enough to authorize replacement. Pinning restores a recognized cached view; it does not
rewrite requests already consumed by a model. This reduces needless history churn but is **not**
a guarantee of a provider cache hit or lower total cost.

Immediate ingress compression is **off by default**, including after a v0.2 upgrade. Enable it
only deliberately for the supported Claude/MCP paths:

```powershell
cmm config set integration.ingressCompression true
```

Restart persistent bridges after configuration changes. `integration.captureOnly=true` disables
all new projections; it does not stop capture. Uninstall the adapter to stop capture.

## Find the evidence, not just its summary

```powershell
cmm search "EADDRINUSE" --agent opencode --workspace "D:\MyProject"
cmm recall EVENT_ID --find "EADDRINUSE" --limit 1200 --agent opencode --workspace "D:\MyProject"
cmm recall EVENT_ID --out recovered.txt --agent opencode --workspace "D:\MyProject"
```

Search uses overlapping chunks through the first **8 Mi UTF-16 units per input/result field**,
with a legacy metadata/head-tail fallback. It handles middle-of-log evidence and returns the
matched field, offset, coverage and provenance. A search miss is not proof of absence. Terms
must match within a chunk; this is not semantic retrieval. Cursor pagination preserves timestamp
ties. `recall --find` searches the exact archived field, including an unindexed tail. Full export
is exclusive-create and never overwrites a file. Pagination offsets are UTF-16 units, not bytes.

## Work alongside RTK without pretending a summary is an original

CMM does not reimplement RTK command filters or rewrite shell commands. Recognizable RTK commands
or recall markers are marked `upstream-filtered` and are not compressed again. This conservative
marker detection can have false positives/negatives; it is not a comprehensive filter detector.
Ordinary host observations have **unknown upstream completeness**, even with a valid local hash.

Explicitly copy an RTK recovery record from a database you own:

```powershell
cmm import-rtk --database "D:\RTK\recall.db" --hash 012345abcdef --agent opencode --workspace "D:\MyProject" --dry-run
cmm import-rtk --database "D:\RTK\recall.db" --hash 012345abcdef --agent opencode --workspace "D:\MyProject"
```

The adapter targets RTK **v0.50.0's SQLite layout**. It reads a local store without running RTK,
executing output hints, changing its rows/counters, or contacting a service. Missing or foreign
project records are refused. Complete entries have RTK's command+payload digest and length checked;
truncated entries remain explicitly partial, including hidden-tail records. A separate SHA-256
protects the copied bytes. The imported record is not asserted to be a particular host invocation.

An optional `integration.rtkDatabasePath` in CMM's JSON config enables copying referenced entries
during capture. It is `null` by default; no filesystem-wide database discovery happens. Associations
remain **unverified upstream hints**; the filtered host event is never silently upgraded to full
source evidence. CMM retention then governs its own copy, not RTK's external retention policy.
See [RTK provenance details](docs/UPSTREAM_CONTRACTS.md).

## Upgrading v0.2

Stop agents/bridges and back up the **whole storage directory**, including WAL/SHM sidecars and
blobs. First open migrates schema v3 to **v4** transactionally. Existing originals stay intact;
legacy observations remain `unknown` rather than receiving invented provenance. Run:

```powershell
cmm verify --agent opencode --workspace "D:\MyProject"
cmm reindex --agent opencode --workspace "D:\MyProject"
```

Reindex once per source agent/workspace (or explicit shared read scope) to populate the new chunk
index. Old v0.2 projection counters are retained as history, not promoted to hash-bound receipts.
Already-compacted legacy text may require explicit recall; CMM does not trust an old marker alone.
Rollback requires restoring the complete backup. Old executables cannot write a schema-v4 archive.

## Development and verification

```text
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run test:pack
```

The 2026-10-05 Windows run has **179 tests: 177 pass, 0 fail, 2 platform skips**, including original regressions, actual
v0.1/v0.2 schema fixtures, corruption checks, concurrent writers, independent protocol peers,
RTK schema fixtures and real CLI subprocesses. The distributable check installs the actual local
tarball into an isolated directory. The Windows smoke covers paths with spaces, demo, setup,
uninstall and verify. CI for Windows/Linux/macOS is configured, not claimed green.

The demo's 95.51% character reduction is one synthetic example, **not** a measured API-token,
billing, cache-hit or task-quality improvement. Read [the full validation boundary](docs/RELEASE_VALIDATION.md).

The archive is local **plaintext** and can contain source code and credentials. Preserve its
privacy. Nothing is automatically deleted by default. GC requires configured limits and explicit
confirmation, applies to the entire selected storage, and cannot guarantee a hard disk quota.
[Security](SECURITY.md) | [Architecture](docs/ARCHITECTURE.md) | [License](LICENSE)
