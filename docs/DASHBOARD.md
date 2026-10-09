# Local management dashboard

Use Node >=22.16 with an existing `config.json` and `cmm.db` storage directory. The source
checkout requires `npm run build`; the distributable already contains the browser assets.

```powershell
node .\dist\src\cli.js dashboard --storage "C:\path\to\cmm-storage" --port 18181 --open
```

In a source checkout, `scripts/start-dashboard.ps1 -Storage <dir> [-Port n] [-Open]` is a
convenience wrapper around the same command; it requires a prior build and is not packaged.

Omit `--port` to select an available port. `--agent` defaults to `codex` and `--workspace` to the
current directory, but they only select the initial scope; the UI can switch to any scope present
in the storage. The printed `launchUrl` has a one-use fragment token; the UI removes it after login
and uses a cookie named `cmm_session_<port>` (HttpOnly, SameSite=Strict, `Path=/api`, valid 8 hours)
plus CSRF protection, so dashboards on different ports can be logged in at the same time. Only the
exact printed `127.0.0.1:<port>` Host/Origin is accepted; `localhost` is refused. Credentials never
appear in configuration read DTOs. To reopen after the cookie expires, restart the dashboard for a
fresh launch link.

Ctrl+C or input EOF stops the HTTP service and waits for the SQLite worker to close (5 s grace
before it is terminated). A second Ctrl+C forces exit with code 130. If the worker stops
unexpectedly, the dashboard prints `[cmm] dashboard worker stopped unexpectedly; restart the
dashboard` and exits with code 1.

## Pages and actions

- Realtime: actual capture/archive/index/scoring/provider operations, fresh/stale instance state,
  provenance-labelled timestamps, scope totals and local model health. Remote models show saved
  configuration, not an inferred live connection. Host context token occupancy is unknown.
- Evidence: scoped literal search, filters and signed pagination, provenance/hash distinctions,
  safe text rendering, bounded original paging, exact hash-verified download, pin and unpin.
- Sessions/chains: scoped source relations, member evidence and separately loaded capsules.
- Models/calls: global provider configuration and ledger, literal credential keep/replace/delete,
  editable environment references, role ordering and explicitly triggered synthetic model tests.
- Strategies/integrations: global stored configuration, known capability boundaries and revision
  conflicts. Saving adopts the settings in the panel worker; other persistent hosts need reload.
- Diagnostics: sanitized environment summary (the workspace appears only as a short `sha256:`
  digest), explicit scope integrity checks and search reindex.
  Maintenance has progress and cooperative cancellation; it never retries automatically after
  timeout/restart. Cancellation cannot undo already completed reindex batches. The page polls
  only while a maintenance job is running.

## Configuration writes

Configuration writes reread under a shared writer lock and atomically publish complete validated
JSON. A stale browser revision receives a conflict; reload before reapplying the edit. A lock
left by a dead process on the same host is removed automatically; any other lock (live process,
other host, unreadable or older format) causes a refusal naming `config.write.lock`. See
[Operations](OPERATIONS.md#configuration). A UTF-8 BOM at the start of `config.json` is tolerated.

A provider with `apiKey` or `apiKeyEnv` must use https unless its host is `localhost`,
`127.0.0.0/8` or `[::1]`; keyless providers may use http. Changing a provider's base URL origin
(scheme/host/port) requires replacing or deleting its stored key. A model-only edit keeps the
stored URL's query string. The https rule applies to added or changed provider entries. Older
entries that violate it still load and survive unrelated saves, but providers refuse to send
credentials over plain http to a non-loopback host (that call fails and the conservative fallback
applies). If settings were saved but the writer lock could not be removed, the panel adopts the
saved settings and shows a warning; close other CMM processes, then delete `config.write.lock`.

Provider tests use saved settings and fixed synthetic input; remote requests may incur charges.
Opening the UI and polling do not submit model requests.

## Downloads and API errors

Downloads are fetched in-page and errors appear inline. One original field may be at most
32 MiB and the event's input and result together at most 64 MiB; larger originals stay available
through paged recall, and the button is disabled with an explanation over the limit. Content
downloads preserve exact UTF-8 bytes including BOM/CRLF/NUL.

API errors carry specific codes: `CONFIG_CONFLICT`, `CONFIG_BUSY`, `MAINTENANCE_RUNNING` and
`JOB_RUNNING` (409), `NOT_FOUND` (404; unknown scope, session, chain, capsule or provider),
`SIZE_LIMIT` (413), and `INVALID_REQUEST`, `INVALID_CURSOR`, `INVALID_SETTINGS`, `INVALID_JSON`,
`INVALID_COMMAND` (400). Authentication and origin failures are 401/403 (`AUTH_REQUIRED`,
`HOST_REJECTED`, `ORIGIN_REJECTED`, `ORIGIN_REQUIRED`, `CROSS_SITE`, `CSRF_REQUIRED`). A request
body over 128 KiB is 413 `BODY_LIMIT`, a non-JSON POST is 415 `JSON_REQUIRED`, a full operation
queue (16) is 429 `QUEUE_LIMIT`, a stalled worker call is 504 `TIMEOUT` (never retried) and a
stopped worker is 503 `WORKER_STOPPED`. Any other failure returns `OPERATION_FAILED` without
internal detail. Pagination cursors expire after one hour; they survive a settings save
(per-process key) but are invalid again after a dashboard restart.

## Observation and limits

The runtime channel is lossy diagnostics, distinct from immutable evidence and the provider
ledger. The storage `runtime/` directory holds a lease file and up to 128 `slot-NNN.json` files
(at most 64 KiB each), written through a temporary file and rename. Persistent processes publish
at most about every 250 ms; short hooks flush when the operation ends. Each instance keeps up to
64 recent events/32 activities and a snapshot up to 256 recent events/128 activities. Workspace
ids longer than 256 characters appear as `sha256:<hex>`. The panel rewrites a corrupt lease on its
next heartbeat, and slot claims remove a few stale temporary files. Slots can recycle; stale activity is
never shown as currently running. A live panel lease is required; observation errors do not fail
capture or upstream tools. Older already-running hosts need reload to emit this channel. Absence
is unknown, not proof that capture is connected or that no work happened. Native Codex/Kimi hooks
remain capture-only.

No raw captured text, prompts, API keys or provider error bodies enter runtime observation.
No GC, deletion, backup/restore, host trust modification, autonomous model testing or GPU
process control is exposed.
