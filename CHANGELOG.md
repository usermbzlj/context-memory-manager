# Changelog

## 0.3.0-rc.2 - 2026-10-07

### Breaking

- `cmm launch kimi` is removed. It targeted the archived Python `kimi-cli`; Kimi Code 2.x has no
  `--config-file`/`--mcp-config-file` flags. Use `cmm setup kimi`.

### Changed

- Kimi Code 2.x: `setup kimi` adds capture-only `[[hooks]]` tables for the workspace to the user-level
  `$KIMI_CODE_HOME/config.toml` (default `~/.kimi-code`), with a backup, and writes
  `.kimi-code/mcp.json`. Uninstall removes only that workspace's tables. A missing Kimi config is
  refused (`setup all` reports it as skipped). Hooks outside the workspace exit silently.
- Kimi outputs at the host's 2,000-unit `tool_output` limit are archived as partial and never
  projected; Kimi's `tool_call_id` is used.
- Claude hooks use exec form (`command` + `args`), avoiding Git Bash/PowerShell quoting; an earlier
  shell-form CMM hook is replaced on setup and recognized on uninstall.
- MCP: the memory server accepts `initialize` through 2025-11-25 and stateless 2026-07-28 requests
  (`server/discover`, `_meta` protocol version, `resultType`, `-32022`). The proxy keeps the legacy
  handshake and asks upstream servers for 2025-11-25.
- With no retention providers configured, the conservative scorer is primary instead of a
  provider scorer that can only fall back.
- Fresh databases create `tool_events` with the session-aware unique key directly; an unrecognized
  legacy definition is refused instead of migrated with a session-blind key.
- Toolchain: TypeScript 7, `@types/node` 26, explicit `types`/`rootDir`/`lib` in `tsconfig.json`;
  CI covers Node 22.13, 22, 24 and 26 with current GitHub Actions majors.

Schema remains v4. The installed Kimi Code 2.1.1 host was exercised with a scripted local model;
real-model Kimi, Claude, Codex and OpenCode sessions remain unvalidated. See
`docs/RELEASE_VALIDATION.md`.

## 0.3.0-rc.1 local hardening - 2026-10-05

### Fixed

- Idempotent Windows workspace paths, including available parents and UNC scopes; a unique
  equivalent legacy workspace/session keeps its stored identity, and conflicts are refused.
- Restore now requires a complete result page. Input reads cannot restore an unrelated output.
- OpenCode preserves explicit truncation metadata as partial evidence, including RTK hints.
- Recalled views no longer mutate source chains or borrow their freshness. Explicit source-member
  chain pins retain their documented scope; old foreign members are excluded without rewriting metadata.
- Derived clipping preserves Unicode pairs, so persisted projections and pin restoration remain exact.
- Retention and cached restoration share dynamic protection checks after asynchronous work.
- Projection reuse and verify share event/session, mode, representation and both-hash validation.
- Awaitable child shutdown and ordered fixture cleanup prevent deletion before SQLite/stdio close;
  pack and Kimi cleanup retain temporary files if shutdown cannot be confirmed.
- Concurrent default configuration creation no longer overwrites another opener's complete settings.

Schema remains v4. No original identities or bytes are migrated by this hardening. Back up the
whole store before updating; restoring the complete backup is the supported rollback. Live-agent
and task-quality gates remain open. See `docs/RELEASE_VALIDATION.md` for executed checks.

## 0.3.0-rc.1 - 2026-10-02

### Changed

- Default first-use ingress compression is off. Existing configs inherit the conservative default;
  enabling it is explicit, and MCP projection additionally requires a declared read-only tool.
- Historical publication uses verified outputs in the current request, a pressure gate, concrete
  batch savings, persisted cooldown, emergency override, pins/recall protection and atomic receipts.
- Persisted views are bound to source and output digests and reused byte-for-byte across calls.
  A spoofed or edited archive marker never authorizes a replacement. NUL output stays unprojected.
- Search now covers overlapping content chunks with explicit coverage, scoped stable cursors and
  exact-field literal recall targeting, rather than relying only on head/tail snippets.

### Added

- Schema-v4 provenance, index manifests, independent RTK copies, unverified hint links and history
  batches. Legacy records retain unknown completeness and support explicit reindexing.
- Read-only RTK v0.50.0 SQLite importer, CLI dry-run, optional explicit database integration,
  digest/length/project/codec/UTF-8 validation and truthful partial hidden-tail handling.
- Public provenance/RTK adapter exports and upgraded disposable lifecycle demonstration.
- Regression tests for actual v0.2 migration, middle/unindexed-tail retrieval, tiny-page find,
  timestamp ties, history anti-spoofing/stability, NUL/corrupt bytes, RTK failures and scoped pinning.

### Fixed

- Blob integrity now verifies disk bytes before decoding: corrupt UTF-8 can no longer disguise
  itself as a legitimate replacement character before the hash check.
- Cross-agent shared reads cannot change foreign event pins; restored sessions use independent
  target views in history decisions.
- Old projection counters no longer serve as proof that an arbitrary CMM-prefixed text is genuine.
- `--version` prints the version rather than falling through to help.
- CLI exports now disclose provenance instead of letting `verified` imply upstream completeness.

### Upgrade and verification

Back up the whole store before schema-v4 migration. Reindex relevant scopes. Older executables
cannot write the upgraded store; roll back from a complete backup. This is still an RC with no
live Windows/agent/RTK binary or task-cost certification. See the current validation report.

## 0.2.0-rc.1 — 2026-09-21

From a frozen core prototype to a runnable local integration release candidate.

### Added

- Scoped `MemoryService`, evidence search, verified paged input/result recall, pin/unpin,
  provenance/decision inspection, exact UTF-8 export, reindex and integration observations.
- Bounded stdio memory MCP server, five tools and a tools-only upstream MCP proxy.
- OpenCode plugin with a persistent Node bridge, first-presentation protection and restart-safe
  projection handles. Non-git root sentinels do not merge unrelated workspaces.
- Claude native post-tool capture and shape-preserving large successful Bash stdout replacement.
- Codex capture-only hooks; Kimi capture-only temporary launch wrapper. No fabricated replacement APIs.
- Previewable, backed-up, conflict-aware setup and uninstall for all four integrations.
- Disposable offline end-to-end demo and isolated local-tarball installation/protocol smoke.
- Expanded regression, race, subprocess, scope, corruption, protocol and integration tests.
- Windows/macOS/Linux Node 22/24 CI configuration, reference docs and release gates.

### Corrected

- Session-less tool identity, conflicting duplicate acceptance, provenance-moving recalls,
  N+1 recalled-view queries, multi-agent workspace collisions and migration handling.
- Archive integrity checks for inline and external data; canonical path/symlink validation;
  embedded-NUL TEXT truncation; malformed UTF-16/UTF-8 handling.
- GC unlink-before-record ordering, shared blob safety, chain/view pin protection and
  starvation behind protected candidates.
- Invalid model JSON/score handling, stale async decisions after pins, conservative pressure
  triggering, initiating edit chain membership and growing capsule provenance.
- Tail test/error evidence, failed-before-passed verdicts, shell side-effect underclassification,
  context-tool recursion, configuration validation and metadata log redaction.
- Cross-agent shared restore is refused instead of assigning a foreign session; diagnostic errors
  omit JSON source snippets and HTTP response bodies.
- Unknown-model price guesses were removed. Provider token reporting remains; legacy cost zeros
  mean unpriced, not free, and old estimates are not promoted as accurate billing.

### Breaking/operational notes

Schema v3 is a forward migration. Back up the entire archive before upgrading and do not open
it with v0.1. New integrations namespace host session IDs. Legacy archive access remains through
its stored identity; use search/event IDs instead of guessing a previous session key. CLI now
requires explicit agent/workspace scopes for most diagnostic and retrieval views. GC acknowledgement
is required and applies to the entire storage. API currency totals are not provided.

This candidate has not been published to npm/GitHub and is not certified against live host sessions.
See `docs/RELEASE_VALIDATION.md` for exactly what was executed.
