# Operations

## Storage and scope

Default root: `~/.context-memory-manager`. Override with `CMM_STORAGE` or explicit `--storage`.
Use exactly the same storage and workspace for capture, retrieval and diagnosis. Commands
also require the corresponding `--agent` (`opencode`, `claude`, `codex`, `kimi`, or a custom
import identity); their default is `cli`, not whichever host last ran.

```text
storage/
  config.json      Validated settings; prefer API-key environment variables
  cmm.db           SQLite metadata, inline text, views, FTS evidence index, receipts
  cmm.db-wal/shm   Active SQLite sidecars, when present
  blobs/aa/bb/sha  Content-addressed captured UTF-8 payloads
  logs/            Bounded metadata diagnostics, not a second full transcript
```

An event ID is the unambiguous archive handle. Its original agent/workspace/session/tool-call
provenance is immutable. Host session IDs are namespaced before storage. Recycled tool-call
IDs in different sessions are allowed; a retry with the same full identity but different
content is a conflict, not a successful archive. Cross-session recall creates a view instead
of reassigning the source event. `--shared` explicitly expands archive access across agents
inside one workspace. It never removes the workspace boundary. Foreign-agent recall cannot use
`restore` or change pins; inspect its data without assigning a view to the caller's session.

Windows capture and retrieval use the same canonical path policy, including a not-yet-created
project's available parent. A unique equivalent legacy path/session keeps its stored identity.
If old aliases conflict, access fails with an explicit error: back up the whole store and inspect
the identities rather than renaming or merging archive rows. Recalled views use their target
session's turn counter and do not join the source session's mutable work chain.

## Configuration

```powershell
cmm config show
cmm config set strategy '"balanced"'
cmm config set integration.maxOutputChars 12000
cmm config set integration.ingressCompression false
cmm config set integration.minHistorySavingsChars 2048
cmm config set integration.historyCooldownTurns 3
cmm config set integration.captureOnly true
```

Shell quoting of JSON strings differs by shell. Editing `config.json` directly is also
supported; retain valid JSON and restart persistent bridges/agents afterwards. Boolean and
numeric examples above require no nested quotes. Bad JSON is not silently reset. Unknown
config keys, invalid ranges and unsafe provider URLs are rejected. `config show` redacts
literal API keys; environment variable names remain visible for diagnosis.

Balanced is the default strategy. With no provider configured, deterministic fallback remains
functional and never fully evicts an event. Optional `providers.retention`, `providers.capsule`
and `providers.chain` arrays use user-defined order. A provider entry has `kind`, `name`,
`model`, optional `baseUrl`, and preferably `apiKeyEnv`. Supported kinds are `openai-compatible`,
`anthropic`, `gemini` and the test-only `fake`. CMM does not subscribe to or resell a model.

A local OpenAI-compatible loopback endpoint can omit authentication. Remote endpoints require
an API key. Invalid provider JSON triggers the next configured provider. Invalid custom scores
fall back conservatively. No paid-model endpoint was exercised in the local validation.
Provider token counts are recorded when reported; legacy numerical `cost_usd` fields are now
**unpriced zero sentinels**, not free requests or measured billing. Old ledger rows may contain
v0.1 heuristic prices. The new CLI avoids presenting them as accurate spending.

`captureOnly` disables projection, not capture. To stop capture, uninstall the managed adapter
and restart the host; for Kimi, stop using the launch wrapper. Never delete a live database to
turn a feature off.

## Diagnosis and recovery

```powershell
cmm doctor --agent opencode --workspace "D:\MyProject"
cmm verify --agent opencode --workspace "D:\MyProject"
cmm reindex --agent opencode --workspace "D:\MyProject"
```

Doctor reads actual integration observations, checks archive hashes and compares generated
installation files. It cannot prove that a running model received a replacement or that its
current context is smaller. Zero observations mean capture has not been seen in that scope;
installing only the memory MCP server is not automatic native capture.

Search indexes overlapping content chunks through 8 Mi UTF-16 units per input/result field,
with legacy metadata/head-tail fallback. Inspect per-result coverage; a miss is not proof of
absence. Old archives need explicit `reindex` to populate the new chunks. FTS token terms must
occur within a chunk; ordering is recency, not semantic relevance. Use returned `nextCursor`
with the identical query/scope to paginate timestamp ties without skipping records.

`recall EVENT_ID --find "literal" --limit 1200` finds text in the verified full archive, including
unindexed tails, and returns bounded context with a match offset. `recall EVENT_ID --out new.txt`
is the exact bulk path; the destination must not exist. Exports and recall metadata disclose
provenance. A valid local hash never upgrades unknown/filtered/partial evidence to complete.
Use returned `nextOffset`, not byte counts; Unicode pairs are not split. Every page verifies the
whole original, so many tiny pages of a large blob cost more I/O than one export.
`--restore` is allowed only for a complete single-page result read. Input recall is read-only;
requesting input or a partial result with restore fails before state or protection is changed.
`verify` checks both receipt hashes, supported representation/mode and target-session membership,
as well as the original archive. Its success does not certify upstream completeness or host use.

## Optional RTK recovery copying

Use `import-rtk --database PATH --hash 12HEX --agent AGENT --workspace PROJECT --dry-run` first.
Dry-run does not create CMM storage. Remove `--dry-run` to copy the record. This never installs or
executes RTK; it requires a source SQLite database readable by the same user. Wrong schema,
missing/foreign project, bad digest, invalid UTF-8 and bounded decompression failures are refused.
RTK's `truncated` flag is retained. A partial hidden tail cannot be promoted to a full original.

To opt into capture-time copying, set `integration.rtkDatabasePath` to the explicit full database
path in CMM's JSON config (Windows backslashes must be escaped), leaving all other settings intact.
Default is `null`. Restart bridges. Imported records appear separately in search and in
`relatedEvidence` with `unverified-upstream-hint`; they are not asserted to belong to that exact
host call. Imported copies are governed by CMM's own retention. The external RTK store, its
counters and retention remain unchanged. Private output is duplicated locally by this opt-in.

A hash mismatch is a real archive failure. CMM will not replace that output or invent missing
data. Restore a known-good backup before continuing. SHA-256 detects content inconsistencies;
it is not an access-control boundary against a process that can rewrite both database and blobs.

## Retention is explicit deletion

Defaults `storage.retentionDays = null` and `storage.maxSizeBytes = null` mean no automatic
archive expiry. Visibility `EVICT` does not delete an original. Cleanup requires configured
caps and an explicit CLI acknowledgement:

```powershell
cmm config set storage.retentionDays 90
cmm gc --yes
```

**GC applies to the entire selected storage, not just `--agent` or `--workspace`.** Only cold,
evicted, unpinned and unprotected originals are candidates. Live recalled views and chain
pins also block cleanup. Caps may therefore remain unmet. GC retires database references
before unlinking an unreferenced blob; interruption can leave a harmless orphan file instead
of a live row pointing at a deliberately removed file. Files shared by another event are kept.
A tombstone records explicit deletion. Deleted originals are not recallable.

`freedBytes` counts logical input/result payload sizes, not physical disk blocks or deduplicated
savings. SQLite pages, indices, retained capsules and orphan files are not a hard disk quota.
There is no automatic orphan-file vacuum in this release. Do not remove hash files by hand
based only on age or apparent duplication.

## Backup, upgrade, rollback

Stop all relevant agents/bridges first, then copy the **entire storage directory**, including
any SQLite sidecars and blob tree. Back up before the first v0.3 open. Schema v1/v2/v3 archives
migrate to v4; newer schema versions are refused. Existing identities and archived payloads
are preserved. Legacy provenance is unknown; old projection counters are not authenticated
receipts. Legacy compacted text may need explicit recall. Run reindex for relevant scopes after
upgrading. Immediate ingress projection now requires an explicit opt-in, even for old configs. A v0.1/v0.2 executable is not a supported reader/writer for a migrated v4 archive.
For rollback, restore the complete pre-upgrade backup, not just `cmm.db`.

Setup backs up each changed existing agent-config file next to it using `.cmm-backup-*` names.
Uninstall removes only marked CMM configuration, preserves unrelated settings and leaves the
archive intact. New empty JSON config files may remain. Do not commit generated absolute-path
configs, backups or temporary Kimi launch files. Power loss or a hard kill may leave temporary
files; delete stale ones only after checking no corresponding process is running.

On Windows, normal paths with spaces are quoted. Shell metacharacters such as `%`, `!`, `&`
and quotes in generated command paths are refused rather than guessed at. Use an ordinary
installation/project path. This release has unit checks for quoting but no Windows desktop
session was available during local development.
