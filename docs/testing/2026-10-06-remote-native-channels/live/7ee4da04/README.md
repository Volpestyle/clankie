# PC acceptance on runtime 7ee4da04

VUH-1527 remains **In Progress**. This 2026-10-06 live run proves native PC
hire, brief, follow-up, exact completion wake, tracker isolation and an explicit
unavailable outcome after scoped SSH loss. Hired-worker reports, peer discovery
and hand-started reply delivery still fail. [Bounded evidence](acceptance.json)
retains the actual native identities and public API results.

The service's authenticated `/health` reported commit
`7ee4da048fe40682d54e013591032ec06e28f727`, including `9d038fd2` and Pell's
exact-receipt wake fixtures. The supported settlement CLI re-read original
`719dd6b1-2814-4c2b-9eb6-118fb785427c` as `abandoned`. Its evidence and replay
fence remain retained. The new acceptance used fresh intent
`965edf88-0551-4641-93a4-4798348b0a6c`; no original was resent or adopted.

## Observed results

| Check                       | Live result                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hire and brief              | `spawned`, `deliveryStage: consumed`; owned `pc/wF:p2`, native Codex `01a11122-b743-7310-85c6-ae47dc0de220`, final `TESS1527_7EE_a_BRIEF_OK`.                                                                                                                                                                                                                    |
| Native follow-up            | Original child `conv-55b9baad-4de2-46ec-b484-7759d67e5e9f` accepted Steer, `deliveryStage: consumed`; final `TESS1527_7EE_a_FOLLOWUP_OK`.                                                                                                                                                                                                                        |
| Exact completion wake       | Native follow-up turn `01a11126-22d4-7d92-978e-5b94ca40c5a7` completed at `12:18:05.453Z`. Its retained harvest claim names that exact turn and original occupant. Lead run `run-5bea2f49-fc2c-4bb1-b9e3-25639acc0337` was accepted at `12:18:09.991Z`, responded, and completed.                                                                                |
| Tracker isolation           | All five Clankie worker tools were present; independent Linear tools were absent. Clankie's Linear read succeeded, receipt `9a777270-39ae-4992-a3e9-e54aea937ae9`. Both hired TUI and dedicated app-server had scoped `mcp_servers.linear.enabled=false`; the account config hash stayed unchanged.                                                              |
| Hired-worker report         | Both brief and follow-up calls rejected: `No durable native binding is available; nothing was sent.` Roster reports `binding_rejected`, two failures.                                                                                                                                                                                                            |
| Peer discovery and exchange | Discovery rejected `403 native_peer_sender_required`. No admitted target binding was returned, so no second hire or peer send occurred. The two-owned-pane exchange remains unproven.                                                                                                                                                                            |
| SSH-loss refusal            | Ended only the dedicated forward created for this hire, after matching PID, lifetime, runtime parent and unique remote port. A new public child send returned `seat_offline`, `deliveryStage: unavailable`; its dedicated app-server was gone, no replacement or native turn appeared, and no typing fallback ran. The shared fleet link still reported `ready`. |
| Hand-started report         | Direct Herdr start in owned `pc/wF:p1`, with `--no-daemon` and scoped Linear/Swarm isolation. Its single report stored as receipt `9755d44e-61c9-4dd8-a678-098898b4d7c1`; storage alone does not prove a reply.                                                                                                                                                  |
| Hand-started reply          | Steer definitively rejected as unsupported, with `Nothing was sent.` A different fresh Queue message returned `seat_offline`, `deliveryStage: unavailable`, although the original TUI/session remained live and done. Its native history contains no reply turn or acknowledgment marker.                                                                        |

No startup trust prompt appeared. Initial native attachment and both hired turns
completed; the deliberate SSH-loss test does not establish a VUH-1738 startup
trust/reconnect regression. The post-loss doctor observed the shared fleet link
and pane census but marked its separate harness inspector unavailable; that
inspector result is not counted as a pass.

## Remaining gaps

1. Admit the hired PC Codex bridge's durable native binding. Reports still reject
   even though the native hire and follow-up complete.
2. Admit native PC peer discovery, then prove message exchange between two owned
   PC panes. No peer binding was fabricated and no send was retried.
3. Deliver a native reply to a hand-started PC Codex session. Reporting stores,
   but Queue currently resolves the live seat as offline.
4. The managed hire's startup catalog is still described as an embedded,
   unverified session. Actual tool presence was observed; a matched native
   catalog verdict was not established.
5. Claude native follow-up and Stop completion remain unrun pending James's
   personal PC `/login`. Once the Codex gates pass, move this owner-only check
   into the small linked follow-up authorized by Clankie and close VUH-1527.

## Cleanup and source checks

[Cleanup](cleanup.json) closed only `wF:p2` through the native seat API and
`wF:p1` after verifying its exact session, idle state and empty input prompt.
The final five pane/terminal identities equal the baseline, all 26 captured test
PIDs are absent, and the canonical Codex config hash remains
`1646ebaad2844d9cb9de83ccbe2961881b54a037ef72ff7598bfed51f8feee46`.
No accounts, config files, other panes or desktop controls changed.

On the exact deployed source, through the fleet heavy limiter:

- [88 focused tests in three files](focused-tests.txt) passed.
- [Clankie typecheck](typecheck-clankie.txt) and
  [agent-hosts typecheck](typecheck-agent-hosts.txt) passed.
- [Scoped lint](scoped-lint.txt) passed for the sender/proof/watch source and
  focused test files. Formatting, bounded-evidence consistency and local document
  links also passed.

These source checks do not override the live failures. This handoff changes only
evidence and its current-result pointer. The deployed source's prior
[native security approval](../../sender-completion/SECURITY-REVIEW.md) still
applies; no new code repair, full `pnpm check`, eval or simulator ran.
