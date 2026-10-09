# Release validation: 0.3.0-rc.2

Latest record: **2026-10-10, Windows, 0.3.0-rc.2**. Local release candidate; no npm
publication or live-agent certification. The 2026-10-05 rc.1 record, the **2026-10-02 Linux
record** below and earlier v0.2 reports remain historical evidence for their exact snapshots.

## Windows review and hardening: 2026-10-10

Node 24.19.0, Windows 11 (console code page 936), PowerShell 5.1 and 7. Synthetic fixtures and
local loopback servers only; no private archive, paid model, host trust change or live agent session.

| Executed check | Actual result |
| --- | --- |
| Starting snapshot (2026-10-09 source) | `npm test`: 229 tests, 227 pass, **1 fail**, 1 skip. Failure: cross-process configuration writers, `EPERM` creating `config.write.lock` |
| Final clean source suite | `npm test`: **309 tests, 18 suites; 308 pass, 0 fail, 1 Windows file-symlink skip**, exit 0 |
| Same build on Node 22.16.0 | `node --test dist/tests/*.test.js` on Windows: 309 tests, 307 pass, 0 fail, 2 skips (Windows file symlink; this Node build ignores `NODE_USE_ENV_PROXY`) |
| Repeat runs | Before the dashboard fixes: full suite 5 times on Node 24 and 3 times on Node 22.16.0. One Node 22.16.0 round hit `EBUSY` removing a test's temporary directory on Windows; test cleanup now retries removal |
| Remote CI | [Run 37968216772](https://github.com/usermbzlj/context-memory-manager/actions/runs/37968216772) on commit `39b36e6`: all 12 jobs pass (Ubuntu, Windows, macOS × Node 22.16.0, 22, 24, 26), including `npm test` and `npm run test:pack`. [Run 37968763110](https://github.com/usermbzlj/context-memory-manager/actions/runs/37968763110) on `ccb6c58` passed twice; a third attempt failed only because `npm install` of the tarball exceeded the package check's 20 s child timeout on Windows Node 22 (npm steps now get 180 s). [Run 37983373215](https://github.com/usermbzlj/context-memory-manager/actions/runs/37983373215) on `56d1363`: 11/12 pass; Windows Node 22.16.0 failed one test whose 150 ms overall deadline across two real loopback providers ended before the slow runner delivered the second request. The test now uses 1000 ms and still asserts the batch is bounded and falls back |
| Configuration writers | Cross-process concurrency and lock-recovery files repeated 10 times: 10/10 pass. Dead same-host holder recovered; live, foreign-host, unreadable and older-format locks refused with bytes unchanged; release never removes a lock it does not own |
| Offline distributable | `npm run test:pack`: actual tarball installs offline; dashboard assets/auth and exact download, generated hook capture and fail-open, setup/uninstall, MCP handshake and demo pass |
| Windows smoke | `scripts/windows-smoke.ps1` passes under PowerShell 5.1 and 7 with the default 936 console code page; liveAgentTested=false |
| Codex quoting | Real PowerShell 5.1/7 execute generated hooks for paths containing typographic single quotes (U+2018 to U+201B); capture, exact recall and verify pass |
| Provider transport | Redirects refused, 1 MiB/256 KiB reply caps, mid-body stalls aborted, overall batch deadlines shared across failover attempts, credentials refused over plain http to non-loopback hosts; Node 24 `NODE_USE_ENV_PROXY` routing verified not to affect native `systemone` |
| Dashboard boundary | Host rebinding, static traversal, oversized and non-JSON bodies refused; per-port cookies; cursor survives settings save; CLI exits on stdin EOF; worker crash exits 1 |

The smoke script previously decoded CLI output with the console code page, so on Chinese Windows
the exact Unicode comparison failed even though the archived bytes were correct (rerun with a UTF-8
console passed). The script now sets UTF-8 output for its own run and restores the previous encoding.

The first remote CI runs (2026-10-07 run 37593793068, then 37963602794 on this round's first push)
failed; the failures were real and are fixed:

- Node 22.13.0: 213 tests failed with `no such module: fts5`. FTS5 arrived in Node 22's
  `node:sqlite` with 22.16.0, so the supported floor and the CI matrix are now 22.16.0.
- macOS: `test:pack` saw empty `--help` output. `/var` is a symlink there, so the entry-point
  check compared different paths; it now also compares real paths.
- Node 22: hook stderr tests saw the `node:sqlite` ExperimentalWarning; CMM processes now
  suppress only that warning. Failover tests were cancelled because `AbortSignal.timeout()` is
  unref'd; deadlines now use ref'd timers that are cleared.
- Later pushes exposed two intermittent macOS failures. A writer got `database is locked` while
  three processes created one database (now retried with a bound). A stalled reply body waited
  303 s on Node 22.16.0: after garbage collection the weakly held timeout signal no longer reached
  `fetch`. The new GC regression test reproduces the hang locally on Node 22.16.0 for all three
  fetch-based providers before the fix and passes after it; the WAL retry is verified only by CI.

Logs: `windows-2026-10-10-baseline-tests.txt`, `windows-2026-10-10-tests.txt`,
`windows-2026-10-10-tests-node22.16.txt`, `windows-2026-10-10-package.txt`,
`windows-2026-10-10-smoke-ps5.txt` and `windows-2026-10-10-smoke-ps7.txt` under `docs/validation`
(local paths replaced by placeholders). One green CI run is not a flakiness guarantee.

An agent-driven browser walkthrough (not user acceptance) covered every dashboard page and the
original-text drawer against disposable synthetic storage, deleted afterwards. It found that search
results never showed the input summary, matched preview or byte size because the page read field
names the API does not return; event rows now carry the summary, and previews are shown with the
matched terms marked. Also fixed: shareable diagnostics included the full workspace path (now a
short digest), raw enum/epoch/byte values, bare settings-validation error codes, empty-state text shown
before data loaded, stale errors after edits, no feedback for find/pin, and `--agent` help that did
not mention the dashboard default (`codex`). Each fix was rechecked in the browser. Codex native
capture after hook re-trust, real-model hosts, the user's own browser acceptance and
task-quality/token/cost gates remain open.

## Windows local dashboard: 2026-10-09

Node24.19.0/npm11.17.0, Windows11. Bundled React/Vite frontend, loopback HTTP and a dedicated
Node SQLite worker. No private archive content or paid API calls were used in these checks.

| Executed check | Actual result |
| --- | --- |
| Final clean source suite | `npm test`:229 tests,228 pass,0 fail,1 Windows file-symlink skip |
| Installed dashboard | Offline tarball includes HTML/CSS/JS; unauthenticated access refused; one-use login and exact original download pass |
| HTTP/security/config checks | Same-origin, CSRF, authenticated scope boundary, exact BOM/CRLF/NUL/Unicode downloads, maintenance completion, panel adoption and stale-revision conflict pass |
| Shared configuration writers | Independent process lock/reread preserves unrelated edits; existing CLI invalid-config regressions pass |
| Runtime observation | Scoped actual starts/ends, disabled/unavailable channel fail-open, privacy allowlist, lease replacement, stale recovery, bounded files/events, conservative fallback and cooperative cancellation pass |
| Browser rendering | Six pages and original-text drawer inspected in IAB using an isolated4-record fixture; script-shaped evidence displayed as text; manual verify completed4/4 with0 failures |

Observation remains bounded best-effort metadata. Host trust, already-running host adoption,
GPU control, host token occupancy, billing and task-level savings are not inferred from this UI.

## Windows DeepSeek capsule/chain API: 2026-10-09

DeepSeek V4.1 Flash, official `https://api.deepseek.com/v1` endpoint, model ID
`deepseek-flash`, explicit `reasoningEffort: "none"`. The existing local native retention
configuration was preserved; the remote API was assigned only to capsule/chain roles.

| Executed check | Actual result |
| --- | --- |
| Authentication and model discovery | Official model-list request: HTTP 200; requested model present |
| CMM capsule refinement, synthetic isolated archive | Validated JSON; 153 input / 33 output tokens |
| CMM fuzzy chain assist, synthetic isolated archive | Validated boolean JSON; 160 input / 5 output tokens |
| Original evidence | Both synthetic original input/result pairs recovered exactly with hashes verified |
| Clean build and source suite | `npm test`: 209 tests; 208 pass, 0 fail, 1 Windows file-symlink skip |
| Offline distributable | `npm run test:pack`: actual tarball installation and package smoke pass |
| Existing project archive | Doctor: 151 records checked, 0 failures, SQLite integrity OK |

Credentials and configuration backups are outside this repository. The private configuration
permits access only to the current Windows user, SYSTEM and administrators. Validation reports
omit credentials and API error bodies. Live API checks used only synthetic reference lookups;
they do not establish production task quality, billing totals or historical projection support.
Persistent CMM bridges load the new provider settings after reload. Codex native hooks remain
capture-only. Local reports are retained outside this source tree.

## Windows native decision scoring: 2026-10-09

Node 24.19.0, Windows 11, AMD Radeon RX 7900 XT. Local Clef-flash Q8_0 served by
llama.cpp b11510 using Vulkan, 4,096-token context and physical batch; 33/33 layers offloaded.

| Executed check | Actual result |
| --- | --- |
| Clean build and source suite | `npm test`: 207 tests; 206 pass, 0 fail, 1 Windows file-symlink skip |
| Offline distributable | `npm run test:pack`: actual tarball installation, CLI/hook/demo/setup/MCP checks pass |
| Native transport regression checks | Ordered probabilities, proxy bypass, bounded groups including the batch tail, invalid answers, HTTP failure, timeout, input budget and role/configuration checks pass |
| Real local model, isolated synthetic archive | One native request: 658 input tokens, 0 output tokens; unresolved error retained (0.052 safe-to-remove), obsolete scan capsuled (0.813), pinned evidence not scored |
| Local unavailable endpoint | One failed call, conservative fallback, no full eviction; all original input/result bytes remain exactly recoverable with archive hashes verified |
| Existing project archive after configuration | Doctor: 128 records checked, 0 failures, SQLite integrity OK; no historical projection receipts |

The project configuration was backed up outside the source checkout and switched to the native
`systemone` scorer/provider. Existing persistent bridges require reload to adopt it. Native Codex
hooks remain capture-only. Synthetic scenario probabilities are not a calibration benchmark,
actual task-quality result, token-saving claim or completed live historical-projection smoke.
The real model and portable deployment remain outside this source tree.

## Windows hook and evidence repair: 2026-10-08

The user's real Hook statistics showed repeated `hook exited with code 1` after trust was
granted. Executing that exact old generated command through PowerShell reproduced a parser
error before Node launched. The suite below replaces direct-argv-only assurance with real
generated-command execution. Node 24.19.0/npm 11.17.0; schema/source version remain v4/rc.2.

| Executed check | Actual result |
| --- | --- |
| Starting baseline | 188 tests: 187 pass, 0 fail, one file-symlink permission skip |
| Repaired clean-build suite | `npm test`: **200 tests, 18 suites; 199 pass, 0 fail, 1 skipped**, natural exit 0 |
| Generated Codex commands | Real PowerShell 5.1 and 7: old managed command upgraded with backup, unrelated hook retained, idempotent setup, literal paths with Unicode/apostrophe/dollar/backtick/ampersand, exact result recall and hash verify |
| Offline tarball installation | `npm run test:pack`: installed packaged command executed through PowerShell; one fixture archived and recalled exactly; malformed input fails open; setup/uninstall and MCP handshake/discovery pass |
| Windows smoke | `scripts/windows-smoke.ps1` passes under both PowerShell 5.1 and 7, including generated-hook capture, exact Unicode/CRLF recall and a nonempty integrity check; liveAgentTested=false |
| Configuration save | Unknown keys, incomplete replacements and invalid types refused before writes; previous bytes survive; valid CLI settings reopen and legacy partial configs retain defaults |
| Late completeness evidence | Duplicate observation and OpenCode cache learn partial restrictions; cached projections restore originals; spoofed markers, wrong scopes, corrupt receipts, completeness promotion and post-read GC are refused |
| Current project repair | Only the existing project's CMM Hook definition updated, old file backed up, independent archive and capture-only settings retained; no artificial fixture captured into the real project archive |
| Installed Codex hook re-read | Original Codex 0.162.0-alpha.2 app-server `hooks/list`: enabled=true, isManaged=false, **trustStatus=modified**, errors/warnings empty, new command contains the call operator; no model/turn calls or trust writes |

Logs: `windows-2026-10-08-repair-tests.txt`, `windows-2026-10-08-repair-package.txt`,
`windows-2026-10-08-repair-smoke-ps5.txt`, `windows-2026-10-08-repair-smoke-ps7.txt`
and `windows-2026-10-08-codex-hook-repair-readiness.json` under `docs/validation`.

The user deferred re-reviewing/trusting the changed Hook. The real project's in-session MCP
status still has zero captured events. No model call, manual fixture injection, trust bypass
or sandbox change was used to claim native capture. User review/reload followed by a real
tool result, MCP search and exact recall remains required. Other live-host, remote-CI and
task-quality/token/cost gates remain open as recorded below.

## Earlier Windows review and Codex readiness snapshot: 2026-10-08

Node **24.19.0**, npm **11.17.0**, installed Codex **0.162.0-alpha.2**; schema v4 unchanged.
The unmodified starting snapshot again passed 182 tests (181 pass, one Windows file-symlink skip),
offline package installation and Windows smoke. The following evidence applies to the repaired source.

| Executed check | Actual result |
| --- | --- |
| Clean build + full suite | `npm test`: **188 tests, 18 suites; 187 pass, 0 fail, 1 skipped**, natural exit 0 |
| Offline distributable | `npm run test:pack`: actual local tarball installs offline, demo, four-agent setup/uninstall and MCP discovery/handshake pass |
| Windows CLI smoke | `scripts/windows-smoke.ps1`: isolated archive and Kimi home, paths with spaces, demo, setup/uninstall and verify pass; liveAgentTested=false |
| GC regressions | Reindex cannot republish a concurrently retired source; pin cannot publish an orphan; actual evicted source-chain evidence survives reactivation and becomes eligible after freshness expires |
| Proxy protocol boundary | Actual CLI proxy rejects stateless discovery/calls before upstream execution; the legacy call still forwards exactly once |
| Kimi configuration protection | Multiline TOML values are refused before setup/uninstall writes; config/MCP bytes remain unchanged; comments and ordinary single-line strings still work |
| Installed Codex configuration | Original binary app-server `config/read` loads project CMM settings without config errors |
| Installed Codex MCP discovery | `mcpServerStatus/list` for `context_memory` discovers CMM 0.3.0-rc.2 and all five tools, `toolsError=null` |
| Installed Codex hook discovery | `hooks/list` parses project PostToolUse, enabled=true, errors/warnings empty, **trustStatus=untrusted**, isManaged=false |

Source/test log: `docs/validation/windows-2026-10-08-npm-test.txt`. Codex discovery evidence:
`docs/validation/windows-2026-10-08-codex-readiness.json` (local paths omitted).
Package and CLI logs: `windows-2026-10-08-package.txt`, `windows-2026-10-08-smoke.txt`
in the same validation directory. The remaining skip is the Windows file-symlink permission case.
The real binary performs discovery, not a scripted Codex model conversation. Model calls: **zero**.
Project settings were prepared only for this CMM checkout, with a separate archive using
captureOnly=true, ingressCompression=false, no providers and no retention caps. Existing private
archives, other agent configurations and hook trust were not modified. The newly initialized
project archive has zero events; an empty successful verify is not native capture evidence.

Still required for Codex: user review/trust of the exact hook definition, client/session reload,
then a native tool result that can be searched and hash-verified through in-session MCP recall.
Live Codex task quality/context savings, other real-model hosts, OpenCode/Bun, RTK binaries and
remote CI remain unverified. See the current Chinese [review and activation steps](PROJECT_REVIEW.zh-CN.md).

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

### Installed Kimi Code 2.1.1 host

The real `kimi.exe` 2.1.1 ran `kimi -p` against an isolated `KIMI_CODE_HOME` (telemetry and
auto-update disabled) whose only model is a scripted OpenAI-compatible fixture on 127.0.0.1.
Kimi executed the tools itself; only the model's choices were scripted. No credential or paid
model was used. Workspace and storage paths contained spaces.

| Observed | Result |
| --- | --- |
| Untrusted workspace | Kimi warns and skips the project `context_memory` server from `.kimi-code/mcp.json` |
| Trusted workspace | Model receives `mcp__context_memory__context_{pin,recall,search,status,unpin}` |
| Hook delivery | All four native calls archived with Kimi's `tool_call_id`s in one CMM session; a 4,500-char `Bash` output and a 7,332-byte `Read` each arrive as exactly 2,000 bytes and are `partial`; a short `Read` is `unknown`; `exit 3` is archived as `error` via `PostToolUseFailure` |
| In-session MCP | `context_search` from the model returns archived evidence; a capture still in flight was not yet visible (hooks are not awaited) |
| Integrity and removal | `cmm verify`: 4 checked, 0 failed; `cmm uninstall kimi` restores `config.toml` byte-for-byte |

Trust was granted through Kimi's local `kimi web` API rather than the interactive TUI prompt.
Log: `docs/validation/windows-2026-10-07-kimi-live.txt`.

Logs: `docs/validation/windows-2026-10-07-npm-test.txt`, `windows-2026-10-07-package.txt` and
`windows-2026-10-07-smoke.txt`.

Still unverified: Kimi with a real model and the interactive trust prompt, Claude exec-form hooks
in a live host, live Codex and OpenCode/Bun, RTK binaries, a remote CI run of the Node
22.13/22/24/26 matrix, and real task-quality/token/cost comparisons.

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
