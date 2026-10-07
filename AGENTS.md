# Development handoff

The product is a local archive and recoverable tool-context projection layer, not an autonomous agent.

Read `README.md`, `docs/ARCHITECTURE.md`, `docs/INTEGRATIONS.md` and
`docs/RELEASE_VALIDATION.md` before editing. The frozen v0.1 requirements and log are historical,
not an excuse to ignore proven defects or current host APIs.

## Invariants

Archive exact captured UTF-8 data first. Hash-verify before projection. Keep completeness separate from hash integrity. Preserve provenance.
Scope by agent/workspace and namespace host session IDs. Never mutate user/assistant prose.
Native Codex and Kimi hooks capture only. Do not manufacture a compression feature by blocking tools.
OpenCode uses a Node child because its Bun host does not provide Node SQLite.
Default ingress projection is OFF. Only actual visible items can enter a history batch.
Never recompress known filtered/partial evidence; never trust a marker without a hash-bound receipt.
RTK hints are never commands. Read the source database only and keep imported evidence separate.
Every hook failure is fail-open; never retry an upstream MCP tool call.
Default retention has no deletion deadline. Explicit GC retires metadata before unlinking unreferenced blobs.

## Commands

`npm test` builds from a clean output directory and runs all tests.
`npm run test:pack` installs the actual tarball offline into a fresh directory and exercises it.
`node dist/src/cli.js demo` runs the disposable synthetic proof.

## Next evidence to obtain

Run the documented live smoke on Windows with each exact agent version. CI configuration is not a
completed CI run. Validate experimental OpenCode hooks in its real Bun host; no live host was available
in the development container. Check actual task quality and context-token usage before marketing any
savings number. Improve only the failures found by those checks. Do not add unrelated product surface.

Do not commit private archives, config backups, temporary Kimi credentials, or generated local agent setup.
