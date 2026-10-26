# VUH-2816 r2: bounded source repair, not installed acceptance

Imported only the net candidate from checkpoint `cb6c107343de02625eee7d214b70b15e0a22f899`,
original base `83b157cfcfe946dc3af600472cb482a687b39a43`, into the exclusive r2 worktree
on fetched main `bb686c28cc2036252759b9cf718835029546ecb5`. Retained parked ref:
`refs/heads/keep/vuh2816-unbound-bridge-20261026-cb6c107343de`.
Import patch SHA-256: `3373be6f63fa384a8b239a334cbaee2f4007f956036f8fe85aee03e66d4f0844`.
No old tree, main, sibling files or refs were changed.

Earlier candidates `078823bf`, `fd1ae8bc`, and `f433c9f3` (patch `08187b2c…`)
received **CHANGES**, not approval. The original evidence remains in
[the retained checkpoint note](../2026-10-26-vuh-2816-unbound-bridge/README.md).
The prior handoff and every r2 failed attempt are retained in the raw evidence
bundle. No root landing gate, push, real model harness launch, service restart,
settings/credential change, production inbox/broker/queue mutation or eval ran.

## Observed results

| Boundary                        | Evidence and result                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Real registration exploit       | `native-red.log`: isolated sibling with bearer nominated the genuine harness; actual native helper/socket returned **200**, expected403.                                                                                                                                                                                                               |
| Real native boundary            | `final-lifetime-green.log`: **4 files /31 tests passed** including actual Node launcher→harness→MCP grandchild, real HTTP, `observeSocketProcess`, `observeNativeBirth`, native pair census/helper and actual `runMcpCommand` private nonce-file reader. Native test runs, not skipped.                                                                |
| Nonce enforcement falsification | `final-nonce-revert-red.log`: removing only the nonce comparison fails **2/9** boundary tests; restored bytes pass30/30; the final launcher/harness reuse matrix passes31/31. `final-nonce-revert-receipt.json` binds the restored registry SHA-256.                                                                                                   |
| Nonce confinement               | `nonce-launchers-red.log`: real OpenCode fixture exec child inherited nonce before repair. `nonce-launchers-final.log`: **5 files /37 tests passed**, actual exec-child env lacks raw/file variables; only MCP config receives private file. Claude dry-run omits the nonce.                                                                           |
| Compatibility                   | `final-compatibility.log`: **8 files /61 tests passed** (seat launch/dry-run, doctor, capabilities, pumps, shutdown/reconnect, lane MCP and receipt paths).                                                                                                                                                                                            |
| Consumers                       | `consumer-final-tests.log`: unchanged3 files /181 passed; joined import failed during concurrent import edit. `consumer-joined-confirm.log`: joined1 passed after fixture corrections. Owner app dispatch supported; unbound owner-update MCP refused; relay local paths excluded; joined delegated MCP supported and local MCP/binding paths refused. |
| Types                           | Governed service and TUI typechecks passed, plus protocol `tsc`. A final focused compiler input includes all changed TS files and the new actual MCP fixture; initial scratch config could not resolve node types, fixed to the same absolute type-definition approach as the repo runner. Final retry exit0.                                          |
| Docs and code checks            | Scoped formatting/lint, public docs check (10 pages,243 operations), and local links (927 Markdown files) passed.                                                                                                                                                                                                                                      |

The native fixture also covers absent/wrong nonce, shell-depth descendant refusal
on MCP/events/ack/reply, second claimant, real keep-alive socket reuse, heartbeat
claim retention, restart-before-heartbeat squatter refusal, genuine re-registration,
replacement bridge, and dead harness/launcher. PID reuse cannot be forced
reliably with a real kernel; the retained deterministic lifetime test covers
same PID/new birth. A missing helper/platform explicitly skips the native suite;
a present helper that cannot observe a process fails. Missing evidence is never
a native green.

The actual MCP proof replaces only parent-argv harness detection and the downstream
tool bank with fixtures. It tests the bridge command, file reader, MCP SDK,
HTTP route and native admission. It does **not** launch Claude, Codex, OpenCode,
Grok or Prime, exercise an owner/model account, or claim their wrapper topology.

## Repairs and limits

Registration now reuses the native pair census and verifies the named harness is
the registering socket owner's direct child with matching fresh lifetimes.
`seat-context` has conversation selection/creation, no service-issued local launch
ticket. Existing fleet/remote launch-intent proof applies to admitted hires and
delegations; it does not establish a free local operator launch. This bounded
repair does not create a new authority framework.

An operator-bearer holder can still launch its own child and race an empty
conversation. Same-user file reading, deliberate impersonation, ptrace and a
self-asserted launch are not authenticated owner authority. This is an honest
stray guard, not a hostile same-user security boundary.

Codex/OpenCode use MCP-only `CLANKIE_BRIDGE_NONCE_FILE` with private0600 file;
ordinary harness env/argv contain no nonce. Claude retains private per-launch
MCP config; Grok uses ACP MCP-only env. Missing helper, unprovable socket, wrong
parent/nonce/claim now have precise startup/doctor recovery. Doctor reports
last refusal as historical, never as a live harness probe. OpenAPI matches
GET/PUT/DELETE and operator MCP/event admission.

**OPEN:** real supported harness launch compatibility, especially claudeN/node
wrappers and Codex npm→native app-server; OpenCode plugin-host and Grok ACP
parentage/config consumption. **Prime remains refused** until its daemon exposes
the exact launched kernel PID/lifetime and independently verifiable launch edge;
a bare PID claim is insufficient. Source approval cannot close these gaps or
installed acceptance. Per-harness chains and consumed-report recovery:
[seat binding reference](../../../integrations/claude-plugin/README.md#binding-and-the-known-unbound-bridge-gap).

Raw bundle metadata may name parent `bb686c28c` because capture/publication precedes
the source checkpoint commit. The archive's source-file SHA-256 map pins tested
source bytes. The exact committed HEAD and net patch SHA-256 are recorded on
[VUH-2816](https://linear.app/vuhlp/issue/VUH-2816) and `.local/HANDOFF-vuh2816-r2.md`.
GLOBAL owns final integration/harvest; the fresh independent reviewer must read
all launcher diffs line by line before any final root gate.

Inspected raw proof archive: [source hashes, failures and green runs](clankie://evidence/sha256/082cd44aaa0009c1270ff4fa8a67d8cef5c1fa448474462ebfda81aad64bd87e).
