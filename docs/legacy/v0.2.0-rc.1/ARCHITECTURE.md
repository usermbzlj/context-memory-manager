# Architecture

```text
Native hook / OpenCode after-hook / MCP proxy / explicit import
                             |
                             v
           MemoryService (fixed agent + workspace scope)
                             |
                  archive transaction first
                             |
              SQLite metadata + verified SHA blobs
                             |
        descriptor -> chain -> pressure -> retention decision
                             |
                supported text-output projection
                             |
                 event handle + evidence extract
                             |
                 search -> paged exact recall
```

## Boundaries

`src/storage` owns identities, schema upgrades, transactions and content storage.
`src/core` owns lifecycle, retention and explicit cleanup. `src/runtime/memory.ts`
exposes a scoped operational service, evidence search, recall and output projection.
`src/integrations` contains native host contracts and reversible setup.
`src/mcp` exposes the bounded tools-only server/proxy. `src/runtime/bridge.ts` is a private
Node child protocol, not a public network API. `src/cli.ts` opens storage only when a command
needs it; help, version, preview and unknown-command errors do not create a database.

There is no service account, HTTP listener, dashboard, telemetry uploader, vector database,
mandatory model, browser extension, agent binary patch or provider-request MITM.

## Archive semantics

A tool invocation identity is `(agent, normalized workspace, namespaced session, toolCallId)`.
Retries with identical data are idempotent. Conflicts preserve the first archive and report
failure so the caller retains its current output. Captured strings must be well-formed UTF-16
convertible to exact UTF-8. Ordinary small strings are inline; large or NUL-containing strings
are stored in canonical `aa/bb/sha256` paths. Embedded NUL uses blobs because Node/SQLite TEXT
retrieval can truncate it in affected runtimes. Every blob read checks hash and byte count.

Writes use atomic file publication and an SQLite writer transaction. WAL, a busy timeout and
synchronous FULL serialization support local multi-process capture. File publication and
metadata reference decisions share the writer lock with GC. The layer does not claim a
cross-filesystem distributed transaction, a hardware durability guarantee or NFS correctness.
A crash before a database commit can leave an orphan blob; it must not leave a deliberately
referenced half-written file. Nested transactions use savepoints and reject asynchronous
callbacks rather than committing across an `await`.

Source provenance does not move on recall. `event_views` provides mutable visibility state
for another session. Event-level and chain-level pins are checked in the relevant scope;
explicit service pinning protects that event across sessions. New schema migrations are
transactional and refuse forward versions instead of silently downgrading.

## Visibility, not source rewriting

`hot` means the full observed result remains eligible for visibility; `capsule` means condensed
evidence; `evicted` means a minimal recoverable representation may suffice. None of these
states means archive deletion. The host may retain its own full transcript independently.

Pressure considers effective occupancy and a bounded retention loop. Core decisions have
pin, recall and active-chain protection. Optional model scores must be finite numbers in
`[0,1]`; invalid responses fail over. Offline fallback cannot fully evict. Failures and
mutation-like calls are never silently evicted. Model-written facts and anchors are filtered
against deterministic evidence; a confident invention cannot become a capsule fact.

Before returning a projection, the service verifies that the caller's current output matches
its captured representation, verifies archive integrity, checks pins/protection again and
requires meaningful character reduction. Recognized previous projection handles support
restoration. Cross-process pin changes during asynchronous scoring are rechecked before
committing a less visible state. These are local atomic checks, not a distributed lock held
until a remote model consumes a request.

OpenCode presents new outputs once before projecting later history. Persistent protocol
receipts record candidate returned projections per event/mode/session, not acknowledgement
from a model API. Core state and receipt sums are therefore not a live host-context meter.
Claude and the MCP proxy perform bounded ingress projections; Codex/Kimi native adapters only
capture. No adapter rewrites assistant prose or user instructions.

## Recovery interfaces

FTS5 indexes descriptors, the first 8 Ki characters of input and first/last 16 Ki characters
of result. Queries are text, not executable FTS syntax. Unicode fallback searches the same
bounded evidence. Retrieval never mistakes a snippet for the authoritative original.
Paging returns the hash, exact text, UTF-16 offset/end, byte/character totals and `nextOffset`.
Restoring to HOT requires a complete single-page read; partial pages do not reinsert the full
payload. Bulk export is a separate, exclusive-create CLI path.

MCP and the private bridge are newline-delimited JSON-RPC over stdio. Framing rejects invalid
UTF-8 and oversized frames. Standard output contains protocol only. Supported MCP capabilities
are intentionally narrow and documented; upstream calls are never retried after ambiguous
execution. Cancellation does not roll back completed side effects.

## Test strategy

Keep deterministic core tests and failure injection. Add independent subprocess protocol
fixtures so client and server do not merely share the same implementation bug. Exercise
real package contents in an isolated offline install. Record actual tests separately from
configured CI jobs, model claims and live host certification. See RELEASE_VALIDATION.md.
