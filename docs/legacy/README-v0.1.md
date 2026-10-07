> Historical v0.1 reference. The current implementation and verified boundaries are documented in the root README and docs/RELEASE_VALIDATION.md.

# Context Memory Manager

A layered Tool Context memory manager for coding-agent CLIs (Phase 1 Core prototype).

**Core idea: never destroy history. Manage visibility.**

A coding agent's tool calls (reads, edits, test runs, shell commands) accumulate
fast and blow up the context window. This manager archives every tool event
*first* — byte-identical, content-addressed — and only then manages what stays
visible in the hot context: keep it, summarize it into a capsule, or evict it.
Eviction never deletes: `recall()` restores the exact original at any time.

## How it works

```
tool completes
      │
      ▼
┌───────────┐   archive fails? ──► KEEP (nothing enters management)
│  ARCHIVE  │   byte-identical input+result → SQLite (small) / blob store (large)
└─────┬─────┘
      ▼
┌───────────┐   descriptor (deterministic) → chain linking
│    HOT    │   stays fully visible in context
└─────┬─────┘
      │  context pressure (used/window + growth + hot-load) ≥ trigger
      ▼
┌───────────┐   retention scoring (model-backed Jev scorer, batched ≤8/pass;
│   TIDY    │   conservative deterministic fallback on provider failure —
└─────┬─────┘   fallback NEVER evicts, capped at capsule under any strategy)
      │           loops to release (≤3 passes): re-scores, re-checks pressure
      ├──► KEEP      low score → stays hot
      ├──► CAPSULE   medium score → summary + facts stay, bulk archived
      │                              (capsule build fails? ──► KEEP)
      └──► EVICT     high score → hidden from context, archive untouched
                                      (side-effect / failed tools: never evicted)

recall(tool_call_id) ──► EXACT original restored, event promoted to hot,
                         protected from immediate re-compaction
                         (cross-session recall re-homes the event)

gc() ──► enforces storage.retentionDays / maxSizeBytes on COLD data only:
         evicted events, oldest-first; never hot/capsule/pinned/protected;
         blob files removed only when unreferenced
```

### Layered states

| State     | Visible in context | Archive | Recallable |
|-----------|-------------------|---------|------------|
| `hot`     | full input + result | ✅ | n/a (already here) |
| `capsule` | summary + facts | ✅ exact original | ✅ promotes to hot |
| `evicted` | nothing | ✅ exact original | ✅ promotes to hot |

### Module map

```
src/
  index.ts                 public API surface (ContextManager, config, scorers, …)
  cli.ts                   `cmm` command-line interface
  demo.ts                  end-to-end lifecycle demo (npm run demo)
  types.ts                 domain types + service contracts (frozen)
  config.ts                loadConfig / saveConfig / strategy presets (frozen)
  logging.ts               JSONL structured logger (frozen)
  descriptor.ts            buildDescriptor, isSideEffectTool/isInternalTool, estimateTokens
  core/
    context-manager.ts     ContextManager: record → archive → link → tidy → recall
    pressure.ts            adaptive pressure monitor (used, growth, hot-load)
    retention.ts           RetentionEngine: score → floor → keep/capsule/evict
  scoring/
    jev.ts                 JevScorer (model-backed safeToEvict)
    fallback.ts            ConservativeFallbackScorer (deterministic, max 0.85)
  capsule/
    extractor.ts           deterministic capsule drafts
    compressor.ts          CapsuleBuilderImpl (+ failNextBuild test hook),
                           ModelBackedCheapModel (providers.capsule refinement)
  chains/
    linker.ts              RuleChainLinker (path overlap, test-after-edit, failure→fix)
                           + cheap-model assist for fuzzy boundaries (providers.chain)
  providers/
    index.ts               buildProviders()
    fake.ts                FakeProvider (canned responses, scripted failures)
    failover.ts            completeWithFailover (+ provider_calls logging)
    openai-compatible.ts / anthropic.ts / gemini.ts / provider.ts
  storage/
    schema.ts              SQLite DDL + ordered migrations (PRAGMA user_version)
    sqlite.ts              Database query layer (WAL mode, 5s busy timeout)
    archive.ts             ArchiveServiceImpl (+ failNextArchive test hook),
                           normalizeWorkspaceId (PRD §24)
    blob-store.ts          SHA-256 content-addressed blob store
tests/
  util.ts                  makeManager / sampleInput / cleanup / scorer helpers
  archive-failure.test.ts  PRD §47: archive failure ⇒ KEEP
  scorer-failover.test.ts  PRD §47: provider failure ⇒ conservative fallback
  capsule-failure.test.ts  PRD §47: capsule failure ⇒ KEEP
  recall-exactness.test.ts PRD §47: recall restores the EXACT original
  side-effect.test.ts      PRD §47: side-effect tools never silently evicted
  internal-tools.test.ts   PRD §47: context_* tools are audit-only
  lifecycle.test.ts        record → pressure → tidy end-to-end
  chains.test.ts           fix-cycle chain linking + completion
  tidy-loop.test.ts        PRD §4.4: tidy loops to release in bounded batches
  fallback-never-evicts.test.ts  PRD §7: fallback capped at capsule (any strategy)
  batch-scoring.test.ts    PRD §10: Jev scoreBatch, one call per batch, batch failure ⇒ fallback
  idempotent-archive.test.ts     duplicate tool_call_id is idempotent
  workspace-normalization.test.ts PRD §24: workspace identity normalization
  gc.test.ts               PRD §23: gc only removes cold evicted data
  pin-scoping.test.ts      PRD §24: pins are session-scoped
  recall-rehome.test.ts    cross-session recall re-homes the event
```

## Quickstart

```bash
npm install
npm run build
npm test          # build + node --test dist/tests/*.test.js
npm run demo      # end-to-end lifecycle demo (~3s)
```

The CLI (also installed as `cmm` via the `bin` entry):

```bash
node dist/src/cli.js --storage /tmp/cmm doctor
node dist/src/cli.js status
node dist/src/cli.js events --session s1 --limit 10
node dist/src/cli.js events --json | jq .
```

Default storage root is `~/.context-memory-manager` (`defaultStoragePath()`).

## Config reference

`config.json` lives in the storage root. Read/modify via the CLI:

```bash
cmm config get                    # whole config as JSON
cmm config get strategy
cmm config set strategy '"aggressive"'
cmm config set storage.blobThresholdBytes '16384'
cmm config set logging.level '"debug"'
```

| Key | Meaning | Default |
|-----|---------|---------|
| `strategy` | active preset: `conservative` \| `balanced` \| `aggressive` | `balanced` |
| `strategies.<name>.trigger` | pressure ≥ trigger starts a tidy pass | 0.8 / 0.65 / 0.5 |
| `strategies.<name>.release` | tidy until pressure falls below this | 0.62 / 0.48 / 0.35 |
| `strategies.<name>.keepThreshold` | score < threshold ⇒ KEEP | 0.6 / 0.5 / 0.35 |
| `strategies.<name>.evictThreshold` | score ≥ threshold ⇒ EVICT (else CAPSULE) | 0.95 / 0.9 / 0.8 |
| `strategies.<name>.minProtectionTurns` | protection turns granted after a recall | 5 / 3 / 2 |
| `storage.path` | storage root (sqlite, blobs, logs, config.json) | `~/.context-memory-manager` |
| `storage.blobThresholdBytes` | content larger than this goes to the blob store | 8192 |
| `storage.retentionDays` / `storage.maxSizeBytes` | cold-data caps enforced by `cmm gc` (evicted-only, oldest-first; never hot/capsule/pinned/protected) | `null` |
| `retention.scorer` | primary retention scorer: `jev` (model-backed, default) \| `conservative` (deterministic) | `jev` |
| `providers.retention` / `.capsule` / `.chain` | model provider configs per purpose | `[]` (deterministic fallback) |
| `models.cheapModel` | reserved for a real cheap model later | `null` |
| `logging.level` | `debug` \| `info` \| `warn` \| `error` | `info` |
| `logging.dir` | JSONL log dir (`null` disables file logging) | `<storage>/logs` |

## Demo walkthrough

`npm run demo` simulates a realistic agentic session in a temp dir with the
**aggressive** strategy so compaction triggers quickly:

1. **Record** 12 tool events — Read JWT source, Edit (side-effect), failing
   `npm test` (~17KB), Read snippet, Edit fix, passing `npm test` (~17KB),
   noisy `npm install` (~185KB), noisy `ls -laR` (~69KB), plus 4 small filler
   reads. A scripted scorer assigns fixed safeToEvict scores per event so the
   tidy pass deterministically exercises KEEP, CAPSULE and EVICT (no network).
   Each record prints `archived: <tool_call_id> (<bytes>)`.
2. **Pressure + tidy** — reports 55k/60k host tokens, runs `maybeTidy` (retries
   with rising usage until it evaluates), prints a decisions table
   (tool_call_id, tool, decision, score, reason).
3. **Recall** — restores the `npm install` log and prints
   `EXACT ORIGINAL RESTORED: YES/NO`, plus the post-recall state (`hot`) and
   protection turns.
4. **Stats** — counters, events by state, archive bytes, tokens-saved estimate,
   and the storage path.

## CLI reference

```
cmm <command> [options]          global flags: --storage <path> --json
                                              --session <id> --limit <n>

status      storage path, strategy, session/event counts, archive bytes,
            tokens-saved estimate, decisions logged
sessions    id, agent, workspace, current_turn, last_active
events      turn, tool_call_id, tool, status, state, bytes, score
            (--session <id> filters; otherwise newest-first across sessions)
chains      id, status, event count, capsule id
capsules    id, summary (80 chars), facts count, frozen
scores      event, scorer, score, turn
recalls     tool_call_id, turns_until_recall, score, decision, turn
providers   provider, model, purpose, ok, tokens, cost
stats       counters, events by state, archive bytes, tokens-saved estimate
pin         --tool-call-id X | --chain-id Y [--agent A --workspace W]
            [--persistent] [--session S]   (pin is session-scoped when --session
            is given; omit for a global pin)
unpin       same target flags as pin (--session S removes only that session's pin)
gc          delete cold archive data per retentionDays/maxSizeBytes caps
config      get [dotted.key] | set <dotted.key> <json-value>
doctor      storage / cmm.db / tables / blobs / config / providers /
            archive-integrity checks; prints OK/FAIL/WARN, exit 1 on any FAIL
```

Human-readable padded tables by default; `--json` prints machine-readable JSON.
Errors go to stderr with exit code 1.

## PRD conformance & deliberate simplifications

**Invariants covered by tests** (`tests/`, PRD §47):

- archive failure ⇒ KEEP — nothing unarchived ever enters management
- scorer failover ⇒ conservative fallback, which is **never trusted to evict** (capped at capsule under every strategy, including `aggressive`)
- capsule failure ⇒ KEEP — failed summarization degrades, never destroys
- recall restores the EXACT original (byte-identical, unicode-safe), promotes to hot, grants protection turns; cross-session recall re-homes the event into the recalling session; cross-agent recall throws
- side-effect tools are never silently evicted (floor: at least capsule)
- internal tools (`context_*`) are audit-log only — no events, no chains, no scoring
- archive is idempotent on duplicate `tool_call_id` (no second row, no double turn bump)
- tidy loops to release in bounded batches (≤8 events per pass, ≤3 passes; a pass with no state changes stops the loop)
- pins are session-scoped; a pin for session A does not protect the event in session B
- `gc` only ever removes cold evicted data (never hot/capsule/pinned/protected; blob files only when unreferenced)
- workspace ids are normalized (`./x` ≡ absolute path; `~` expands) so one workspace never splits into two

**Deliberate Phase 1 simplifications:**

- **No adapters** — core is agent-agnostic (PRD §51); `recordToolComplete` takes plain `ToolEventInput`
- **Model providers are configured, not built in** — `providers.retention/.capsule/.chain` wire the real model paths (Jev batch scoring, capsule refinement via `ModelBackedCheapModel`, chain fuzzy-boundary assist); with none configured the deterministic fallbacks stand in (`FakeProvider` for tests). `models.cheapModel` remains reserved.
- **No FTS / vector search** — recall is by exact `tool_call_id`
- **Global config only** — one `config.json` per storage root, no per-agent/per-workspace overrides
- **Pressure from host reports + managed load** — no live token streaming; `reportHostUsage` is the signal
- **Chain linking is rules-first** (path overlap, test-after-edit, failure→fix); a cheap-model assist resolves fuzzy boundaries only when the rules find nothing

## Project layout

```
context-memory-manager/
  src/            TypeScript sources (strict, ES2022, NodeNext, zero deps)
  tests/          node:test suites (see table above)
  dist/           build output (tsc) — dist/src/… and dist/tests/…
  package.json    scripts: build / test / demo / cli / clean
  README.md       this file
```
