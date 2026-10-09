# Architecture: evidence-first history management

Version 0.3.0-rc.2 / schema v4 / revised 2026-10-10.

## Separation of responsibility

`src/storage` owns immutable event identities, transactions and byte-faithful originals.
`src/evidence` owns provenance, bounded overlapping search chunks and cursor navigation.
`src/core` owns retention decisions, chains, recall protection, optional scoring and explicit GC.
`src/runtime/memory.ts` owns scoped capture/retrieval and publication of actual candidate views.
`src/integrations` owns host adapters, reversible setup and the read-only RTK store adapter.
`src/mcp` provides a bounded tools-only stdio service/proxy. The private Node bridge avoids
loading Node SQLite inside OpenCode's Bun process.

`src/management` provides scoped read DTOs, verified content/downloads and revision-checked settings.
`src/dashboard` serves the bundled React UI over authenticated loopback HTTP. A dedicated Node
worker owns SQLite operations and cooperative maintenance jobs. `src/observability` provides
optional, bounded best-effort diagnostics while a dashboard lease is alive, never an archive.
No agent binary patch, provider MITM, vector service, account or mandatory LLM exists.
Optional native decision scoring uses a `systemone` retention provider and scorer. The transport
posts typed questions, and the scorer validates and maps their probabilities before the existing
protection/retention engine applies a decision. Native scoring never rewrites prose or changes
host projection capabilities; provider/input failures retain the existing conservative fallback.
Provider transport is bounded: fetch-based providers refuse redirects and cap replies at 1 MiB,
native `systemone` caps at 256 KiB and ignores proxy environment variables, and each batch has one
overall deadline across failover providers (retention 20 s, capsule 45 s, chain 20 s). Expiry
sends the whole batch to the conservative fallback; error text is fixed and carries no bodies,
URLs or keys.

The observation write model is a storage `runtime/` directory with a lease file and up to 128
`slot-NNN.json` files (at most 64 KiB), each published via temp file and rename. Persistent
processes publish at most about every 250 ms; short hooks flush when the operation ends. It is
lossy best-effort metadata, never an archive or evidence.

The retained core is not discarded just to claim a rewrite. Optional scoring remains available;
CLI filters belong upstream, not in another CMM filter registry.

## Identity and evidence

Identity is `(agent, normalized workspace, namespaced host session, toolCallId)`.
An identical retry is idempotent; a conflicting retry preserves the first record and leaves the
current host output unchanged. Event IDs are retrieval handles, not secrets or access tokens.
Cross-session views never reassign the original event. Cross-agent shared access is explicit and
read-only with respect to pins and restoration; workspace boundaries remain.

Windows path normalization is idempotent, canonicalizes available parents and applies
the drive-letter policy after realpath. Path components are not indiscriminately lowercased.
A unique equivalent legacy workspace and host session retain their stored IDs; conflicting
legacy identities are refused rather than merged. No archive identity migration is performed.
Recalled target views have no mutable source-chain identity. Chain membership writes require
the source event's agent/workspace/session, and readers exclude old foreign members without
rewriting their metadata. Global chain pins still protect their original member evidence in
other sessions; active-chain freshness uses only members of the current session's chain.

Every source is valid, exactly representable UTF-8. Small text can be inline, but large/NUL text
uses a canonical content-addressed blob. Reads verify **actual disk bytes** and their length
before fatal UTF-8 decoding, preserving BOM, CRLF and NUL. This avoids corrupt bytes becoming a
legitimate replacement character during decoding and then falsely matching a text hash.

Provenance is independent from integrity. A valid SHA-256 says our captured bytes are unchanged,
not that the upstream tool was unfiltered, complete, current or truthful. Host observations are
unknown-completeness by default; recognized filters and truncation are explicit. RTK imports
retain their own origin and complete/partial status, never replacing host evidence identities.

Repeated observations of the same verified bytes may only add conservative partial/filtered
restrictions; they cannot promote unknown/partial content to complete, replace an imported
source's identity/digest, or change original bytes, event identity or capture stage. A duplicate
capture does not rewrite provenance unless the merge changes it. The private
OpenCode bridge accepts late restrictions only for the same source invocation and exact original
or hash-verified cached history view. It rechecks source existence under the writer transaction.
New partial/filtered evidence restores recognized views and prevents new projection.

## Storage and migration

Schema v4 adds `evidence_provenance`, `evidence_chunks` (FTS5), `evidence_index`, `evidence_links`,
`projection_cache`, and `history_batches`. Derived evidence is deleted when its source event is
explicitly deleted. Old v3 archives retain originals and old counters; missing provenance is
marked legacy and missing chunk manifests require explicit reindexing. Older schema upgrades
still run in order. Future schemas are refused. The v0.2 migration fixture was generated by
executing the uploaded v0.2 compiled migration, not approximating the current schema.

Local SQLite writer transactions, WAL and FULL synchronous mode serialize capture/GC metadata.
Nested transactions use savepoints and reject asynchronous callbacks. Blob publication can leave
an orphan on a crash but GC retires references before unlinking unreferenced data. No distributed
filesystem, hardware power-loss, hostile same-user or NFS durability guarantee is made.
Concurrent initial configuration creation publishes a complete file without replacing another
opener's settings. Explicit configuration changes take `config.write.lock` (`{pid, hostname,
createdAt}`; a lock held by a dead process on the same host is removed, any other is refused)
and use atomic replacement.

## Historical publication, not hypothetical occupancy

`hot`, `capsule` and `evicted` are desired retention views, not proof of model-visible bytes.
Core `tidy` can update those states; only a compatible host transform returns a replacement.
The OpenCode path now works from **only the output items in the current transform request**.
Archived rows absent from the current transcript cannot inflate the calculated release.

A transform reuses/restores existing verified cached views, then applies a pressure gate,
per-session cooldown, protected-event filtering and bounded retention scoring. Newest eligible
items are considered first (at most 24). First presentation, pins, recent recalls and active work
remain protected. Fallback scores never fully evict. Concrete output reduction is measured before
publishing; less than the configured batch threshold makes no new receipts. Atomic publication
rechecks protections, provenance and result hash at commit and records the entire batch, or
returns originals without partial receipts. Evidence that became partial/filtered meanwhile is not
projected, so a batch may publish fewer events than proposed.
A declined batch may leave desired core retention states changed; status explicitly distinguishes
these from views actually returned.

Projection identity includes source event, target session, mode and representation. Both source
and visible SHA-256 are stored. Repeated calls reuse exact cached bytes, even when policy or
extractor defaults change. An altered/spoofed marker is never treated as a valid previous view.
NUL-containing results remain unprojected because TEXT receipt readers may truncate them.
A pin/capture-only setting or newly active local chain restores a recognized cached view,
including at low pressure. Scoring and capsule extraction recheck the same mutable protections
after awaits and inside the publication transaction. Derived clipping preserves Unicode
characters so SQLite round trips do not replace isolated surrogate halves.

Cached use and `verify` share a receipt validator: archive integrity, event/target-session scope,
mode, representation, source SHA-256 and visible SHA-256 must agree. Valid visible text alone
does not make a corrupt source receipt usable.

The archive and receipt checks run before returning output. There is no distributed lock held
until a provider accepts a request: a late pin, host rejection or cancelled model request is not
acknowledged by this layer. First-presentation protection means one successful transform pass,
not proof of actual model consumption. Stable bytes mitigate avoidable prefix churn, but a new
batch still edits history and can affect prompt caching. No caching/cost saving guarantee exists.

## Search and recall

Each field is indexed in overlapping 4,096-UTF-16-unit chunks with 1,024-unit overlap, up to
8 Mi units per field. Manifests disclose indexed and total lengths. NUL is normalized only in the
search index; the authoritative archive is unchanged. Legacy metadata/head-tail fallback remains.

Queries are text, not executable SQL/FTS grammar. FTS token-prefix terms are chunk-local, with
Unicode/punctuation literal fallback. Results are newest-first, not semantic ranking. Cursors
bind query/scope and use `(created_at,id)` so timestamp ties do not skip records. Concurrent new
writes are not a database snapshot and will normally appear in a new search, not old pages.

`recall --find` locates literal text in the verified archive and returns a bounded nearby page,
with its true match offset. Small pages still include the start of the hit. No-match results are
not synthetic summaries. Full-file export is exclusive-create. `restore` requires a complete
single-page **result** read; input and partial reads never reinsert an original into context. Each page verifies
the whole original, so bulk export is more efficient for very large files.

## RTK interoperability

The adapter reads RTK v0.50.0's ordinary SQLite recall table using a read-only/query-only
connection and a coherent read transaction. It checks the table shape, project cwd, codec,
metadata, size and line counts. Raw/gzip input is bounded at 32 MiB before and after decompression.
Full records verify RTK's truncated SHA-256 identifier of `command + NUL + original bytes` and
reported original byte length; partial records cannot pass that full-source test and never claim
to. They may contain a hidden tail with unknown original offset. Copies receive CMM's own full
SHA-256 and independent immutable identity. RTK rows/counters/retention are not changed.

Optional automatic association uses an output hint only to select a copied record; the link is
`unverified-upstream-hint`, not a proven invocation relationship. Neither the hinted shell command
nor any binary is executed. No RTK code or binary is redistributed. This was verified against
pinned source and schema fixtures, not a running RTK executable or a live agent installation.

## Protocol and operating bounds

JSONL stdio: 32 MiB frames, at most eight concurrent inbound requests; no public listener.
Memory MCP supports five tools, legacy `initialize` (2024-11-05 through 2025-11-25) and stateless
2026-07-28 requests with `server/discover`. The tools-only proxy negotiates the legacy handshake
upstream and has no resources/prompts/sampling/HTTP
passthrough, never retries uncertain upstream execution, and projects only explicitly opted-in,
read-only-declared, eligible text results. An annotation is not a permission bypass.

See `RELEASE_VALIDATION.md`, `UPSTREAM_CONTRACTS.md`, and `SECURITY.md` for evidence and limits.
