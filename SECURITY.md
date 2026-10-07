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
configuration includes absolute local paths. Kimi temporary launch configs can contain copied
API keys and may survive a hard kill; remove stale files after checking the process has stopped.

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

For a vulnerability report, share a minimal synthetic reproduction through a private channel
with the repository maintainer. Do not post real archives or keys in public issues. No maintainer
contact/repository URL is fabricated in this pre-publication release.


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
