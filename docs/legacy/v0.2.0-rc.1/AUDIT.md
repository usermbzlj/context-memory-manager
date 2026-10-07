# Audit: frozen v0.1 core to v0.2.0-rc.1

Date: 2026-09-21. Input: the user-supplied frozen ZIP. Findings below are source-analysis
and reproduced regression findings, not claims about attacks observed in real deployments.
Original requirements and development notes are preserved under `docs/legacy`.

## Product diagnosis

The original core had useful retention, capsule, chain, pin, recall and persistence code,
with 38 passing tests. The missing product loop was observing actual host tools, safely
changing supported output views, retrieving exact evidence, and installing the integration
without disturbing existing agent configuration. More scoring features alone would not close
that gap. The release keeps the core concepts but adds a bounded operational boundary.

## Findings, corrections and evidence

| Finding / risk | Correction in this release | Regression evidence |
| --- | --- | --- |
| A repeated tool-call identity could be accepted without proving its new content matched the archive | Session-inclusive identity; compare exact content/metadata; conflict retains the first archive and fails open | `memory-service.test.ts`, `idempotent-archive.test.ts` |
| Cross-session recall moved source ownership and affected protection/accounting | Immutable source event with independent `event_views`; scoped session keys | `recall-rehome.test.ts`, `memory-service.test.ts` |
| Agent workspaces used a single-key identity; recycled IDs could collide | Composite workspace identity and per-session event uniqueness, forward schema v3 migration | `schema-migration.test.ts` including frozen original v2 DDL |
| A shared cross-agent restore could create a session under the wrong agent | Foreign-agent recall is readable but cannot use restore; caller session remains intact | `memory-service.test.ts` |
| A content reference was not sufficient proof that original bytes were recoverable | SHA-256 and byte-count verification for inline/blob data; canonical hash paths; symlink/traversal checks | `memory-service.test.ts`, `durability.test.ts` |
| Embedded NUL text was truncated by SQLite TEXT retrieval in the tested runtime | NUL-containing strings use the blob path even below the normal size threshold | `memory-service.test.ts` |
| Invalid UTF-16 / byte framing could corrupt evidence or split recall text | Reject unpaired surrogates and malformed UTF-8; surrogate-aware UTF-16 pagination | `memory-service.test.ts`, `protocol.test.ts` |
| GC removed files before retiring database references; protected rows could starve later candidates | Commit references/tombstones first; protect shared blobs, chains and views; scan eligible candidates beyond pinned prefixes | `durability.test.ts`, `memory-service.test.ts` |
| File publication, capture and cleanup could disagree during local concurrency | Atomic blob publication under SQLite writer serialization, busy timeout, WAL/FULL, savepoints | Three independent writers capture 60 events in `durability.test.ts` |
| Model validation happened outside effective failover or normalized invalid scores | Validate inside provider attempts; require finite numeric scores in range; conservative fallback | `scorer-failover.test.ts`, `jev-batch-validation.test.ts`, `memory-service.test.ts` |
| A pin arriving during asynchronous scoring could be ignored | Recheck event/view and chain protection before committing reduced visibility and before projection | `memory-service.test.ts`, `pin-scoping.test.ts` |
| Important final log verdicts could be missed or classified incorrectly | Bounded head/tail evidence, explicit verdict order, conservative mutation detection | `memory-service.test.ts`, descriptor/capsule suites |
| Initiating mutations and growing chain provenance were incomplete | Include initiating event and update chain capsule source IDs | `chains.test.ts` |
| Bad config or error diagnostics could silently reset state or echo private content | Strict config validation without reset; redact key fields; omit JSON parse source and HTTP error bodies | `privacy.test.ts`, `memory-service.test.ts` |
| Native integrations and tools-only MCP were absent | Separate adapters with documented, tested capabilities; Node bridge; five scoped memory tools | `integrations.test.ts`, `protocol.test.ts` |
| Proxy compression could destroy structured results or repeat side effects | Preserve error/schema/image/annotation shapes; forward each upstream call once, including on failure | Independent upstream/peer fixtures in `protocol.test.ts` |
| A broad OpenCode worktree sentinel could merge unrelated non-git projects | Use project directory when worktree is the documented global-root sentinel | `integrations.test.ts` |
| New output/history projection could get ahead of first presentation; restart could re-archive a capsule | Track presented calls; scoped archive lookup and verified projection receipts survive restart | Actual plugin factory and Node bridge in `integrations.test.ts` |
| Installation could overwrite unrelated settings or appear successful without usable contents | Preview, ownership markers, conflict/concurrent-edit checks, backups, reversible uninstall | `integrations.test.ts`, isolated installed-package smoke |
| Guessed model prices or projection counters could imply real savings | Remove price guesses; label zero as unpriced; distinguish receipts, character counts and measured billing | CLI/docs; no billing-saving claim |

Tests are regression evidence for specific behavior, not a proof of correctness for every host,
filesystem, crash timing or input. Existing tests that encoded provenance moving or conflicting
retry acceptance were updated to the corrected invariants; the new tests exercise those cases
independently rather than retaining a false expected result.

## Scope deliberately not added

No accounts, web dashboard, vector database, team management, cloud sync, telemetry uploader,
agent binary patch, traffic interception proxy, automated GitHub publishing, arbitrary shell
execution by memory tools, or large benchmark platform. Runtime dependencies remain zero.
Official host extensions and a minimal local archive serve the actual workflow.

## Remaining release risks / limits

1. Actual Windows desktop, macOS, live Claude/Codex/Kimi/OpenCode and OpenCode/Bun execution
   are unverified here. The CI matrix is configured, not remotely run. Beta/experimental host
   APIs can change. Current capability descriptions are not installed-version certification.
2. Archives and copied temporary configurations are private plaintext. New-file mode restrictions
   are not Windows ACL enforcement, encryption or an authorization boundary. Processes able to
   modify both metadata and blobs can defeat hash consistency checks.
3. Host-side truncation before observation is unrecoverable. Search is metadata plus bounded
   evidence, not exhaustive content or semantic retrieval. Each page re-verifies the original;
   repeated tiny pages of huge blobs are inefficient.
4. The MCP implementation is a bounded tools-only stdio subset, not full MCP or a general gateway.
   Host compaction, other MCP servers and native tools outside the adapter are not intercepted.
5. GC is explicit logical retention, not a hard physical disk quota. Crash leftovers may be orphan
   blobs; automatic orphan vacuum is not implemented. Shutdown backups must include the whole store.
6. No external paid provider or real-task token/cost/quality comparison was run. Synthetic-demo
   character reduction is not evidence that every task becomes cheaper or equally accurate.
7. Configuration formats outside the implemented merge subsets are refused; preserving user data
   takes priority over automatically rewriting arbitrary JSONC/TOML or unusual Windows shell paths.

The next useful evidence is a real Windows host smoke and a small set of paired real tasks,
not expanding the feature checklist. See `RELEASE_VALIDATION.md` for executed checks and manual gates.
