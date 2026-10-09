# Changelog

## 0.3.0-rc.2 dashboard, native scoring and hardening - 2026-10-10

### Added (2026-10-09)

- `cmm dashboard`: local loopback management UI (React/Vite, build-time-only dependencies) with
  a management service, realtime view, scoped evidence search/download, sessions/chains, provider
  configuration and ledger, strategies and cancellable maintenance. See `docs/DASHBOARD.md`.
- Bounded runtime observation under storage `runtime/` (lease + up to 128 slot files): lossy
  diagnostics, never evidence.
- Native `systemone` retention scorer/provider for a local decision server.
- `reasoningEffort` for `openai-compatible` providers. DeepSeek was used only for capsule/chain
  in validation.
- `npm run test:pack` now builds first instead of trusting an existing `dist`.

### Hardening (2026-10-10)

- Dashboard: session cookie is `cmm_session_<port>`; Ctrl+C/stdin EOF waits for the SQLite worker
  (5 s grace, second Ctrl+C exits 130) and an unexpected worker exit prints a message and exits 1;
  downloads are fetched in-page with inline errors and limits (32 MiB per field, 64 MiB per
  event); specific API error codes (`CONFIG_CONFLICT`, `CONFIG_BUSY`, `MAINTENANCE_RUNNING`,
  `NOT_FOUND`, `SIZE_LIMIT`, `INVALID_*`) with 413/415 for oversized/non-JSON bodies; pagination
  cursors survive a settings save; diagnostics poll only during maintenance.
  `scripts/start-dashboard.ps1` added for source checkouts.
- Configuration: writer lock records `{pid, hostname, createdAt}`; a dead same-host holder is
  recovered, anything else is refused by name; Windows sharing errors retry; a UTF-8 BOM is
  tolerated. Reclaim is serialized and a writer only removes a lock it still owns; a save whose
  lock could not be removed is adopted with a warning. Added or changed providers with
  credentials must use https except loopback; older violating entries still load and survive
  unrelated saves, but never send credentials in cleartext. Changing a provider URL origin
  requires replacing/deleting its key; model-only edits keep the URL query.
- Providers/scoring: fetch-based providers refuse redirects and cap replies at 1 MiB; native
  `systemone` caps at 256 KiB, requires HTTP 200 and ignores proxy environment. One overall
  deadline per batch (retention 20 s, capsule 45 s, chain 20 s), shared across failover attempts,
  with conservative fallback; errors carry fixed text only.
- Runtime observation: temp-file + rename slot writes, publish throttle of about 250 ms, long
  workspace ids shown as `sha256:<hex>`, stale temporary files swept and a corrupt lease repaired.
  Timed-out maintenance acknowledgements are released after 5 minutes.
- Codex Windows hooks also double typographic single quotes (U+2018 to U+201B) for PowerShell
  5.1/7.
- `verify` ignores events retired by GC during the run; real corruption is still reported.
- A history batch rechecks provenance and result hash at commit; evidence that became
  partial/filtered is not projected.
- Duplicate captures do not rewrite provenance unless the merge changes it.
- `.build/` private build directories are ignored by Git.

### Cross-platform fixes found by remote CI (2026-10-10)

- Node floor raised to **22.16.0**: earlier Node 22 `node:sqlite` builds lack FTS5, so the old
  `>=22.13.0` claim never held. The CLI refuses older versions with that reason.
- The CLI and demo run when launched through a symlinked path (macOS `/var`, npm links); before,
  `--help` printed nothing there.
- CMM processes suppress only Node 22's `node:sqlite` ExperimentalWarning, so hooks leave the
  host's stderr empty.
- Provider deadlines use ref'd timers that hold their controller strongly and are cleared when
  the request ends; the reply body is cancelled directly on expiry. On Node 22, garbage
  collection could drop the weakly held `AbortSignal.timeout()` link and a mid-body stall waited
  about 300 s (undici's default) instead of the deadline.
- Opening a new database retries `SQLITE_BUSY` while switching to WAL, which SQLite can return
  without consulting `busy_timeout` when several processes create the same database at once.

Schema/source version unchanged; local RC, not published. Validation is recorded in
`docs/RELEASE_VALIDATION.md`; 2026-10-10 Windows full suite: 308 tests, 307 pass, 0 fail, 1 Windows
file-symlink skip (Node 24.19.0); the same build also passes on Node 22.16.0. Remote CI run
37968216772 passed on Ubuntu, Windows and macOS with Node 22.16.0, 22, 24 and 26.

## 0.3.0-rc.2 Windows hook and evidence repairs - 2026-10-08

- Codex Windows setup uses PowerShell's call operator and literal quoting. Re-running setup
  upgrades old managed commands while preserving unrelated hooks and backing up the old definition.
- Configuration saves reject unknown keys, incomplete replacement objects and invalid field types
  before writing; accepted settings remain loadable and older partial configurations retain defaults.
- Repeated verified observations retain late partial/filtered restrictions. OpenCode's cached
  calls accept those restrictions through a scoped private bridge, validating originals or
  hash-bound receipts and rechecking source existence under the writer transaction.
- Full suite: 200 tests, 199 pass, one Windows file-symlink skip. Offline package checks and
  PowerShell 5.1/7 smoke now execute generated hooks, recall exact evidence and verify hashes.
- Current project hook was upgraded with a backup. Installed Codex reads it without errors,
  but reports trustStatus=modified; user review/reload and live-session capture remain pending.

Schema/source version remain unchanged; this is a local RC repair, not a published release.

## 0.3.0-rc.2 local hardening - 2026-10-08

- Reindex and pin recheck source existence under the writer transaction after awaited reads,
  preventing retired evidence from republishing search text or creating orphan pins.
- GC honors source-chain reactivation using the same protection policy as runtime projection.
- The legacy tools-only proxy rejects stateless discovery/requests before forwarding upstream.
- Kimi setup/uninstall refuse triple-quoted TOML values before any write rather than mistake
  embedded hook examples for managed tables. Comments and ordinary single-line values still work.
- Generated local Codex config/hook files are ignored by Git. Schema and source version remain
  unchanged; this is local RC hardening, not a new published release.
- Windows suite: 188 tests, 187 pass, one file-symlink skip. Installed Codex discovers five MCP
  tools; its native capture hook still requires user trust. See `docs/RELEASE_VALIDATION.md`.

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
