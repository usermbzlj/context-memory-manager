# Release validation: 0.2.0-rc.1

Recorded: **2026-09-21**. This is a local release candidate, not a published GitHub/npm
release and not live-agent certification. The test runner output and package-smoke report
are included under `docs/validation` in the source release.

## Environment and provenance

- Linux container; Node **v22.16.0**; npm **10.9.2**.
- Development began from the supplied `context-memory-manager-v0.1.0-frozen-2026-09-21.zip`.
- Its baseline had **38 passing tests**. Development dependencies already supplied in that
  archive were used to compile; no registry install was available in the container.
- No runtime npm dependencies. SQLite comes from Node; this Node version can print its
  experimental SQLite warning on standard error, never on the protocol standard output.
- No personal agent configuration, private repo, cloud account or paid model was used.

## Executed successfully

| Check | Actual result | Reproduce |
| --- | --- | --- |
| Strict TypeScript build + complete automated suite | **99 tests, 18 suites; 99 pass, 0 fail, 0 skipped** | `npm test` |
| Isolated package test | Packed a real tarball, installed it offline without scripts into a new prefix | `npm run test:pack` |
| Installed CLI smoke | Help, complete demo, setup preview, four-target setup/uninstall | Included in package check |
| Independent installed MCP client | Initialize + initialized notification + five-tool list against installed executable | Included in package check |
| End-to-end evidence demo | 177,046 -> 7,950 UTF-16 characters, 15 pages, exact SHA-256 reconstruction | `node dist/src/cli.js demo` |
| Local concurrency | Three separate Node processes, 60 calls, one shared result blob, all hashes verified | `tests/durability.test.ts` |
| Protocol interoperability | Independent line-based peer, actual CLI server and CLI proxy, separate upstream process | `tests/protocol.test.ts` |
| OpenCode integration internals | Actual plugin factory + real Node bridge, first presentation, restart lookup, pin restoration | `tests/integrations.test.ts` |
| Native hooks | Official-contract synthetic success/failure fixtures, actual CLI subprocess fail-open behavior | `tests/integrations.test.ts` |
| Schema upgrade | v1-shaped migration and a database rebuilt from the **actual original v0.1 schema-v2 DDL**; retained exact data and corrected identities | `tests/schema-migration.test.ts` |
| Data protection | Conflicting retries, foreign scopes, Unicode/NUL, corruption, pins/races, GC ordering, future-version refusal | Core + new service/durability tests |
| Configuration/privacy | Conflicts, preservation, rollback/uninstall, Windows command quoting, malformed JSON/body omission | Integration, service and privacy tests |

The two public source/runtime entry points and docs are package-listed; tests and `node_modules`
are not shipped in the npm tarball. The source ZIP includes tests and a prebuilt `dist/src`,
so an end user can run the demo without downloading development dependencies.

### Demo hash

```text
585dece61a458985cb90df2b1cc34b9ed9f4eed5ec67ab88cbfbb74c7cd9ff96
```

Visible character reduction in this particular synthetic log is **95.51%**. This measures
neither tokenizer output nor API billing nor task quality. Projection receipts likewise
record candidate projections returned, not acknowledgement from a live model request.

## Specifically NOT executed / NOT claimed

- Windows or macOS desktop smoke; real host sessions in any of the four agents.
- A real OpenCode/Bun plugin session. Testing the factory with a Node bridge is not that test.
- GitHub Actions jobs. The configured matrix is Linux/Windows/macOS and Node 22/24;
  a configured workflow is not a green remote check.
- Paid provider API calls, production network compatibility, full MCP conformance, latest MCP
  feature coverage, long-running load, disk-power-loss testing or NFS/shared-volume correctness.
- Real-task quality non-regression, measured billing savings, universal model compatibility.
- GitHub or npm publication, signing, verified downloads, community adoption or star counts.

## Manual gates before a stable release claim

Use a disposable project/archive and an installed artifact. Record exact OS, Node and host
versions, whether configuration was approved, commands run and observed outputs.

1. **Windows install:** run help/demo, setup preview/apply and doctor from a normal path with
   spaces. Confirm model/provider/permission settings are unchanged. Uninstall and inspect diffs.
2. **OpenCode:** produce a large ordinary text result, verify first display remains complete,
   continue enough history to trigger projection, recall exact evidence, pin, restart and check
   original visibility/provenance. Confirm a non-git workspace stays isolated.
3. **Claude:** observe a documented successful Bash envelope and ensure only stdout is replaced
   after verified capture. Errors/unknown output shapes remain untouched. Recall the saved envelope.
4. **Codex/Kimi:** prove capture observations and exact MCP recall in real sessions. Do not expect
   native compression. Kimi wrapper must preserve existing providers/MCP settings and clean up its
   temporary configs after normal exit.
5. **Failure path:** a blocked archive directory, unavailable Node bridge or malformed hook input
   must leave the original tool result usable. MCP proxy timeouts must not execute a tool twice.
6. **Small real-task comparison:** collect actual input-token usage and task outcome from the host
   with and without CMM. Include long logs, an error-fix-retest chain and exact-output inspection.
   Keep model/context/tool settings comparable. Do not infer performance from the synthetic demo.

These are remaining validation tasks, not promised background work. Retain RC labeling until
there is actual evidence for the target environment and supported installed host versions.
