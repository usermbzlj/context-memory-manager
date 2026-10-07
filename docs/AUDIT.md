# Engineering audit: 0.3.0-rc.1

Date: 2026-10-02. Baseline: the supplied v0.2.0-rc.1 source-with-build archive.
These are reproduced/code-reviewed issues and current fixes, not third-party audit certification.
Previous reports are preserved under `docs/legacy/v0.2.0-rc.1`.
This report describes the 2026-10-02 snapshot. Later Windows repairs and executed checks are
recorded in `IMPROVEMENT_PLAN.zh-CN.md`, `IMPLEMENTATION_REPORT.zh-CN.md` and `RELEASE_VALIDATION.md`.

| Baseline problem | Implemented change | Executable evidence |
| --- | --- | --- |
| A captured RTK summary could be presented as an original | Independent provenance/completeness; filtered/partial evidence is not reprojected | `evidence-v3.test.ts` detection and default tests |
| Simply chaining filters would not recover original command evidence | Read-only RTK importer; copied evidence stays a separate event; hint link is unverified | `rtk-import.test.ts` full/partial, wrong scope, hint copying |
| Search missed facts in large-log middles | Overlapping chunk FTS with coverage manifests, exact `--find`, Unicode-safe offsets | Middle, cross-boundary and >8 Mi-unit tail tests |
| Timestamp-only pagination could skip ties | Query/scope-bound `(created_at,id)` cursor | Seven equal-timestamp events paged with no duplicates/misses |
| First-use reduction was enabled implicitly | Explicit opt-in; conservative default through migration | Default no-op and ingress integration tests |
| Retention state could be confused with actual visible history | Request-local candidates; concrete preview, pressure gate and batch receipts | Low-pressure, absent-archive and minimum-savings tests |
| Frequent changes could churn prefixes | Hash-bound stable projection cache and persistent tool-turn cooldown | Reopen/config-change stability, cooldown/emergency tests |
| Prefix + old receipt was treated as a recognized view | Require exact current source/cached bytes, source hash and visible hash | Altered marker and corrupted receipt tests |
| NUL could be cut by SQLite TEXT receipt retrieval | Preserve NUL sources unprojected; archive remains byte-backed | NUL projection and original recall tests |
| Invalid raw UTF-8 could decode to the original replacement character before text hashing | Verify disk bytes/length first, then fatal UTF-8 decode | Blob corruption regression in memory-service tests |
| Shared scope could change foreign-agent pins | Cross-agent shared pins/restore are refused | Shared read-only pin tests |
| Target history could use a recalled event's source state | Resolve explicit target event views for history decisions | Independent source/target retention test |
| Small literal-find pages could contain only the leading context | Limit leading context by actual page budget; report match offset | Tiny-page find regression |
| Old schema upgrade would leave provenance/receipt assumptions ambiguous | Transactional v4 migration; legacy unknown flags; explicit reindex; do not promote old counters to receipts | Original uploaded v0.2 compiled-DDL fixture test |

Also fixed the inherited `--version` handling (previously printed help with no positional command);
the CLI regression and installed-package check now assert exact version output.

## Deliberate exclusions

No second RTK command-filter library, shell rewriting engine, SaaS account, telemetry uploader,
vector database, GUI console or agent binary patch was added. RTK is optional. Command execution
and host permissions stay with the original host. No upstream tool is retried after uncertain
execution. No default retention deadline or automatic deletion was added.

## Remaining risks and limitations

The runtime is local plaintext under the user's own authority, not a hostile-user sandbox.
The RTK reader was exercised with pinned-format SQLite fixtures, not a live RTK binary.
The Windows smoke script is provided but not executed in a Windows shell here. OpenCode's actual
Bun-host session and other real host sessions remain manual release gates. Candidate publication
cannot prove provider consumption. First-use means a transform pass, not a model acknowledgement.

Search is bounded, chunk-local and newest-first, not semantic/full-unbounded retrieval. Source
and index may consume significant local disk; every page verifies the full source. GC is not a
hard physical quota or secure erase. RTK marker detection is conservative, not exhaustive.
Cached projections reduce unnecessary changes, but new history edits can still affect provider
caches. There is no live task completion, billing or quality non-regression measurement in this
release. State changes without published views are disclosed, not counted as real savings.
