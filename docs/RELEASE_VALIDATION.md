# Release validation: 0.3.0-rc.2

Latest record: **2026-10-07, Windows, 0.3.0-rc.2**. Local release candidate; no npm/GitHub
publication or live-agent certification. The 2026-10-05 rc.1 record, the **2026-10-02 Linux
record** below and earlier v0.2 reports remain historical evidence for their exact snapshots.

## Windows host-contract update: 2026-10-07

Environment: Windows 11, version **10.0.26300**, x64; Node **24.19.0**; TypeScript **7.0.2**.
No user archive, credential, paid model or live agent session was used. Every test and smoke
run points `KIMI_CODE_HOME` at a disposable directory; the real `~/.kimi-code/config.toml` had the
same SHA-256 and modification time before and after, with no CMM backup beside it.

| Executed check | Actual result |
| --- | --- |
| Clean build + full suite | `npm test`: **182 tests, 18 suites; 181 pass, 0 fail, 1 skipped**, exit 0 |
| Offline distributable | `npm run test:pack`: `context-memory-manager-0.3.0-rc.2.tgz` (165 files) installed offline; help/version, demo, four-agent setup/dry-run/uninstall with byte-exact Kimi config restore, legacy MCP handshake and `server/discover` pass |
| Windows CLI smoke | `scripts/windows-smoke.ps1`: isolated storage and Kimi home, paths with spaces, demo, setup/uninstall and verify pass; `liveAgentTested: false` |
| Kimi Code 2.x setup | Two workspaces in one user config, idempotent re-run, in-place replacement, comment-stripped and literal-string tables recognized, inline `hooks = [...]` refused, missing config refused, byte-exact uninstall |
| Kimi hook payload | 2,000-unit `tool_output` recorded as partial with a dangling surrogate dropped; `tool_call_id` used; hook outside the workspace exits silently |
| Claude exec form | `command`/`args` handler with argv passed verbatim; legacy shell-form CMM hook replaced; unrelated user hook kept on uninstall |
| MCP dual era | Legacy `initialize` through 2025-11-25 with readiness gate; stateless `server/discover`, `tools/list`, `tools/call` and `-32022` for an unsupported version |

The skip is the **file symlink** case, which may require Windows developer mode. The rc.1 POSIX
signal-wrapper skip no longer applies because the Kimi launch wrapper was removed.

Logs: `docs/validation/windows-2026-10-07-npm-test.txt`, `windows-2026-10-07-package.txt` and
`windows-2026-10-07-smoke.txt`.

Still unverified: live Kimi Code 2.x (hook delivery, workspace trust prompt and `.kimi-code/mcp.json`
loading), Claude exec-form hooks in a live host, live Codex and OpenCode/Bun, RTK binaries, a
remote CI run of the Node 22.13/22/24/26 matrix, and real task-quality/token/cost comparisons.

## Windows hardening: 2026-10-05

Environment: Windows 11 Pro, version **10.0.26300**, x64; Node **24.19.0**, npm **11.17.0**.
Input: the existing `context-memory-manager-v0.3.0-rc.1` source checkout. Schema remains v4;
no user archive, real agent setup, credential or paid model was used. A source/test snapshot
was retained outside the checkout before edits.

| Executed check | Actual result |
| --- | --- |
| Audited Windows baseline (2026-10-03) | 137 tests: 109 pass, 27 fail, 1 skipped; test cleanup left a child running |
| Clean build + full suite | `npm test`: **179 tests, 18 suites; 177 pass, 0 fail, 2 skipped**, exit 0; natural exit |
| Configuration contention | Six simultaneous initial publishers produce exactly one complete winner; three independent writers preserve all 60 events. Both tests repeated **5 times**, all pass |
| Offline distributable | `npm run test:pack`: actual tarball installed offline; help/version, demo, four-agent setup/uninstall and independent MCP handshake pass |
| Windows CLI smoke | `scripts/windows-smoke.ps1`: isolated storage, paths with spaces, demo, setup/uninstall and verify pass; `liveAgentTested: false` |
| Regression coverage | Legacy Windows/UNC identities and alias conflicts, result-only restore, Unicode round trips, explicit host truncation, chain/view isolation, scoped chain pins, protection races and complete receipt validation |
| Shutdown faults | Actual Node/SQLite bridge and child fixtures, failed spawn, ignored EOF/TERM, exit-before-close and unconfirmed-close deadlines; temporary files retained if close is unconfirmed |

The two skips are explicit platform cases: creating a **file symlink** may require Windows
developer mode, and POSIX wrapper signal delivery cannot be simulated by Windows `kill`.
Other path traversal, direct-child shutdown and escalation tests execute on Windows. Fake Kimi
tests use local Node fixtures and no credentials; they do not certify a live Kimi installation.

Logs in the source bundle: `docs/validation/windows-2026-10-05-tests.txt`,
`windows-2026-10-05-contention.txt`, `windows-2026-10-05-package.txt` and
`windows-2026-10-05-smoke.txt`. These are disposable test evidence, not private archives.
See [the implementation report](IMPLEMENTATION_REPORT.zh-CN.md) for the repaired defects.

Still unverified: live OpenCode/Bun, Claude, Codex, Kimi and RTK; Windows console Ctrl-C and
`.cmd` descendant-tree behavior; remote CI; real task-quality/token/cost comparisons; large
stores with unavailable network workspace aliases. Legacy identity resolution intentionally
checks all candidates to avoid silently missing conflicts. Initial configuration publication
uses a same-volume hard link, tested on this local Windows filesystem; filesystems without hard
link support are not validated. No macOS/current Linux run or durability certification is implied.

## Historical Linux record: 2026-10-02

## Environment and inputs

Linux container; Node **22.16.0**, npm **10.9.2**. The exact input was the supplied
`context-memory-manager-v0.2.0-rc.1-source-with-build.zip`. Development dependencies came from
the user's earlier v0.1 archive; no registry install or external paid model was required.
No personal agent configuration, private repository or cloud account was used.

## Executed checks

| Check | Actual evidence / command |
| --- | --- |
| Unmodified baseline | 99 tests, 18 suites, no failures |
| Strict TypeScript build + full suite on that snapshot | `npm test`: **137 tests, 18 suites; 137 pass, 0 fail, 0 skipped** |
| Original schema migrations | v1-shaped, frozen v0.1 DDL and an independent v0.2/schema-v3 fixture; exact evidence preserved |
| Evidence index and recall | Middle of long log, Unicode/cross-chunk match, same-timestamp cursor, 8 Mi-unit cap and unindexed tail, tiny-page literal find |
| Projection/pressure | Default ingress no-op, visible-only candidates, low-pressure no-op, stable reopen, hash/marker tamper, threshold/cooldown, pin restoration |
| Archive correctness | Raw-byte corruption before decoding, BOM/CRLF/NUL, multibyte boundaries, cross-agent pins and cross-session views |
| RTK adapter | Actual v0.50.0-shaped SQLite fixtures: full/raw/gzip, partial hidden tail, source digest/length/line metadata, wrong workspace, malicious references, invalid UTF-8/codec, missing store |
| CLI import | Actual subprocess dry-run with no destination creation, import then exact recall |
| Retained concurrency/protocol tests | Three separate writer processes and independent protocol peers, real Node bridge, real CLI gateway, no uncertain upstream retries |
| Lifecycle demo | `node dist/src/cli.js demo`; all behavior assertions pass; no API calls |

The test suite distinguishes fixtures and internal adapter tests from real upstream execution.
New tests do not turn a local contract simulation into host certification. Full logs are under
`docs/validation`; the release also supplies them separately.

## Distributable check

`npm run test:pack` builds an actual local tarball from the compiled checkout, installs it offline
with scripts disabled into a disposable prefix, and checks installed help, the full lifecycle
demo, four-agent setup/uninstall, and an independent MCP initialize/tool-list handshake.
Final results are recorded in `docs/validation/package-smoke.txt`. The package contains no runtime
npm dependencies or personal archives. The source ZIP includes prebuilt runtime files and tests.

## Disposable synthetic lifecycle

Input: **177,048 UTF-16 units**. Historical view: **7,950**. Character reduction: **95.51%**.
Paged recall: **15 pages**; exact SHA-256 reconstruction:

```text
faba2c8e5eb0c22a6c8c672d2aa4f62c4de1c1de0be4d865fd54437def563f1a
```

The demo checks first-use preservation, below-pressure no-op, actual batch projection,
byte-stable reuse, mid-log evidence, full recall, pin restoration and no second RTK compression.
Usage supplied to its policy is synthetic and explicitly estimated. These numbers measure
neither a real tokenizer nor provider billing, cache hits or task quality.

## Not executed / not claimed in the 2026-10-02 Linux run

No Windows or macOS desktop shell session; no live OpenCode/Bun, Claude, Codex or Kimi session;
no running RTK binary; no remote GitHub Actions job; no external paid-model compatibility test;
no task-quality/cost A/B test; no full MCP conformance, long soak, power-loss or shared-filesystem
durability certification; no GitHub/npm publication or signing. The Windows script and CI matrix
are runnable materials, not completed runs.

## Manual release gates

On the intended Windows machine, run `scripts/windows-smoke.ps1` from the source bundle, then
use a disposable real agent project. Record Node, host, plugin and RTK versions; capture a large
result, verify original first presentation, continue to real pressure, recall a specific middle
fact, pin, restart and uninstall. For Codex/Kimi, expect capture-only native behavior. For Claude,
expect capture-only until ingress is explicitly enabled. For RTK, inspect a real same-project
record, confirm its copied completeness and test expiration/failure without breaking host output.

Then compare a few matched long tasks with and without CMM/RTK, recording actual host input,
cache-read/write tokens, task completion, missing-evidence incidents and latency. Do not choose
settings from the synthetic reduction percentage. Retain RC labeling until those gates have
real evidence.
