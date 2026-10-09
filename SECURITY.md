# Security and privacy boundaries

CMM operates as your local user. It is not a sandbox and does not change agent permissions.
It never retries an upstream tool invocation to conceal a timeout or archival failure.

**The archive can contain credentials, private source code and personal data. It is not encrypted.**
Captured tool input/result strings are preserved intentionally. Automatic secret replacement
would break exact recovery. Keep the storage directory, SQLite sidecars, content blobs and
backups private. Newly created files use restrictive POSIX modes where supported; no Windows
NTFS policy, multi-user isolation or encryption guarantee is implied.

Diagnostics avoid full transcript logging and redact common credential keys/patterns. This is
not a universal secret detector. Review diagnostics before sharing them. Git remote metadata
is local project metadata; a credential-bearing remote should not be used. Generated agent
configuration includes absolute local paths. `cmm setup kimi` edits the user-level Kimi Code
`config.toml` and leaves a `.cmm-backup-*` copy beside it; that copy can contain the same provider
API keys as the original. Stale `.cmm-launch-*` files from earlier releases can also contain keys.

Default operation is offline. If you configure retention/capsule/chain providers, their requests
can contain tool descriptors, snippets, paths, outcomes and capsule drafts. Those may be private.
Use only endpoints you trust. Environment-variable API keys avoid storing literal keys in CMM's
config but do not prevent the selected provider from seeing its requested evidence.

Memory content is historical untrusted data, not instructions, permission grants or guaranteed
current repository state. Use exact recall before edits. SHA-256 verifies stored content but
cannot protect against a same-user process that can rewrite both the hash and payload. Scope
checks reduce accidental cross-project access; they do not sandbox code with filesystem access.

Before opening an untrusted project's CMM-generated hook/plugin config, review its paths and
commands with the host's normal approval workflow. Do not approve an unknown plugin solely
because it uses a CMM-looking filename. CMM does not bypass project trust.

For a vulnerability report, share a minimal synthetic reproduction privately with the maintainer of
https://github.com/usermbzlj/context-memory-manager. Do not post archives, logs containing secrets
or keys in public issues.

## Local dashboard

`cmm dashboard` is a local HTTP service with these boundaries:

- It binds only to loopback and checks the exact Host and Origin values.
- The launch URL carries a one-use token in its fragment; keep it private. After login the browser
  holds an HttpOnly SameSite per-port cookie (`cmm_session_<port>`) and writes need a CSRF token.
- Configuration read DTOs never contain credentials. A literal API key you enter is stored in
  `config.json` in plaintext, with user-only permissions where the OS supports it; prefer
  environment variables.
- Provider tests run only on explicit request and may incur charges. Opening or polling the UI
  sends no model request.
- `runtime/` observation metadata excludes captured text, prompts and keys.
- Credentials are refused over cleartext http to non-loopback hosts.
- No GC, deletion, backup/restore or host-trust edits are exposed.

The dashboard is not an authentication boundary against another process running as your user.


## Evidence introduced by filters and importers

Integrity, completeness and origin are different. A local checksum is not source authentication.
RTK recovery hints are untrusted data: never execute them and never infer that a hinted payload
belongs to an exact invocation merely because its bytes verify. The optional reader uses an
explicit local database, checks scope/format and copies into a separate record; partial payloads
remain partial. No database auto-discovery, RTK executable, telemetry or silent hook installation
is involved. SQLite read-only access does not defeat a same-user attacker or provide a universal
sandbox for hostile database files. Do not import stores from unknown parties.

Search chunks and stable projection text are additional local copies of sensitive evidence.
They follow source deletion but can remain in SQLite free pages until separately maintained;
GC is not secure erasure. The 8 Mi-unit search cap is not a source-file cap. A valid index result
or a complete RTK-store flag does not make recalled instructions trustworthy.
