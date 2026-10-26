# VUH-2816 r3: doctor priority and stale-launch startup recovery

This repairs both required findings on candidate
`5947d27d-05cb-41f8-b7b3-9d4bbd5bdcec`, patch
`b235f620597f7ae1d600a3f7bc750d01b500ac68` (HEAD `93a62a525a41479b35a5c9f214be3b6d08d564a2`).
That candidate received **CHANGES**, not approval. The earlier
[r2 proof and original import provenance](../2026-10-26-vuh-2816-r2/README.md)
remain unchanged evidence. Work stays in the same exclusive source worktree,
with GLOBAL the only integration/harvest owner.

## Required repairs and inspected evidence

| Finding                                       | Red reproduction                                                                                                                                                      | Repair and green                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Historical doctor refusal masked live faults  | `doctor-summary-red.log`: restored original KH2 headline assertion fails in both existing scenarios. `diagnostic-state-red.log`: three demanded lifecycle cases fail. | Last refusal stays in the report body, while the live disconnected bridge retains its headline. Normal `seat_binding_required` retries are not retained. Successful register/admit clears a refusal for that conversation only. Both the historical body assertion and original live headline assertion hold.               |
| Relaunched MCP failed on an old dead launcher | `native-stale-red.log`: actual `runMcpCommand` exits on `seat_binding_stale`, before the replacement launcher's PUT.                                                  | Existing bounded startup retry accepts only the primary JSON error field `seat_binding_required` or `seat_binding_stale`. Real native test observes stale→required, zero tool-bank access before registration, then successful MCP list after the genuine replacement launcher registers. Other refusal codes remain final. |
| Orphan startup-window comment                 | Source inspection                                                                                                                                                     | Comment moved onto the bounded startup constants.                                                                                                                                                                                                                                                                           |

All test/check commands ran through `clankie heavy`; no real model harness,
owner account, installed service, broker/inbox/queue or other live body was driven.
Native fixture/helper/HTTP/MCP are real, and helper absence is explicit skip,
never a native green. Parent-argv detection and downstream tool bank remain
fixtures; native Node processes do not establish real harness compatibility.

Final focused suite: **6 files,38 tests passed** (`final-native-green.log`):
operator-seat-bindings, operator-seat-binding-routes, real native/MCP lifecycle,
unbound bridge, doctor coexistence, and nonce confinement.
The new native relaunch test is one of **two executed native cases**, not skipped.
Final nonce-enforcement falsification: disabling only the nonce comparison fails
**2/10** tests, restoring the exact bytes passes38/38. Receipt pins registry
SHA-256 `d3711065612be71e960f1f54aea182bf7e304f1211f9b09380ec59d4af353d92`.
The original direct-child/nonce checks and launcher confinement are unchanged;
previous valid full compatibility/typecheck evidence remains linked in r2.
Changed-file typecheck, scoped lint/format, docs and links are recorded in this
capture. All failed attempts remain in the archive.

The archive's source-file hashes bind the tested source before this commit;
its metadata may name reviewed parent93a62a525. The exact new committed HEAD,
base, candidate and patch hash live on
[VUH-2816](https://linear.app/vuhlp/issue/VUH-2816) and the worktree handoff
`.local/HANDOFF-vuh2816-r2.md`.

## Still open

Source review never closes installed or original real-operator acceptance.
ClaudeN shell exec/fork and node wrappers, Codex npm→native app-server,
OpenCode plugin-host/config consumption and Grok ACP/leader parentage remain
unverified. Prime still lacks the verified exact kernel PID/lifetime and launch
edge; its local operator bridge remains refused. Joined/remote seats use their
delegated route and refuse local operator MCP by design. The operator-bearer
own-child/empty-conversation race remains an accepted documented same-user
stray-guard limit, not authenticated owner authority.
No root gate, push, integrate, rollout, real service/harness/plugin restart,
credential/settings/account mutation, eval or waiver ran.

Inspected archive: [CHANGES verdict, source hashes, red/green runs and final nonce-revert receipt](clankie://evidence/sha256/6fd6310b6dbcb1b13f82f4291047f349023ca23e48dfa9004f5b92d0a8d7d83b).
