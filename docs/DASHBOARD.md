# Local management dashboard

Use Node >=22.13 with an existing `config.json` and `cmm.db` storage directory. The source
checkout requires `npm run build`; the distributable already contains the browser assets.

```powershell
node .\dist\src\cli.js dashboard --storage "C:\path\to\cmm-storage" --port 18181 --open
```

Omit `--port` to select an available port. The printed `launchUrl` has a one-use fragment token;
the UI removes it after login and uses an HttpOnly SameSite cookie plus CSRF protection.
Only exact loopback Host/Origin values are allowed. Credentials never appear in configuration
read DTOs. To reopen after the cookie expires, restart the dashboard for a fresh launch link.
Ctrl+C or input EOF stops the HTTP service and waits for the SQLite child to close.

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
  timeout/restart. Cancellation cannot undo already completed reindex batches.

Configuration writes reread under a shared writer lock and atomically publish complete validated
JSON. A stale browser revision receives a conflict; reload before reapplying the edit. An orphan
writer lock causes safe refusal rather than automatically stealing a possibly active lock.
Provider tests use saved settings and fixed synthetic input; remote requests may incur charges.
Opening the UI and polling do not submit model requests.

## Observation and limits

The runtime channel is lossy diagnostics, distinct from immutable evidence and the provider
ledger. It uses 128 fixed file slots (at most64 KiB each), up to64 recent events/32 activities
per instance and up to256 recent events/128 activities per snapshot. Slots can recycle; stale
activity is never shown as currently running. Short hooks emit start/end without persistent
timers. A live panel lease is required; observation errors do not fail capture or upstream tools.
Older already-running hosts need reload to emit this channel. Absence is unknown, not proof that
capture is connected or that no work happened. Native Codex/Kimi hooks remain capture-only.

No raw captured text, prompts, API keys or provider error bodies enter runtime observation.
Content downloads are bounded to32 MiB and preserve exact UTF-8 bytes including BOM/CRLF/NUL;
larger originals remain accessible through existing paged recall. No GC, deletion, backup/restore,
host trust modification, autonomous model testing or GPU process control is exposed.
