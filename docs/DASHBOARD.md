# Local management dashboard

Use Node >=22.13 with an existing `config.json` and `cmm.db` storage directory. The source
checkout requires `npm run build`; the distributable already contains the browser assets.

```powershell
node .\dist\src\cli.js dashboard --storage "C:\path\to\cmm-storage" --port 18181 --open
```

In a source checkout, `scripts/start-dashboard.ps1 -Storage <dir> [-Port n] [-Open]` is a
convenience wrapper around the same command; it requires a prior build and is not packaged.

Omit `--port` to select an available port. `--agent` defaults to `codex` but only selects the
initial scope; the UI can switch to any scope present in the storage. The printed `launchUrl`
has a one-use fragment token; the UI removes it after login and uses an HttpOnly SameSite cookie
named `cmm_session_<port>` plus CSRF protection, so dashboards on different ports can be logged in
at the same time. Only exact loopback Host/Origin values are allowed. Credentials never appear in
configuration read DTOs. To reopen after the cookie expires, restart the dashboard for a fresh
launch link.

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
- Diagnostics: sanitized environment summary, explicit scope integrity checks and search reindex.
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

API errors carry specific codes: `CONFIG_CONFLICT`, `CONFIG_BUSY` and `MAINTENANCE_RUNNING` (409),
`NOT_FOUND` (404; unknown scope, session, chain, capsule or provider), `SIZE_LIMIT` (413), and
`INVALID_REQUEST`, `INVALID_CURSOR`, `INVALID_SETTINGS` (400). Other failures return a generic
`OPERATION_FAILED` without internal detail. An oversized request body is 413 and a non-JSON POST
is 415. Pagination cursors survive a settings save (per-process key) but are invalid again after a
dashboard restart.

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
