# VUH-2029: two-project Auto window

2026-10-12 16:53:33.403–18:53:33.403Z, deployed
`6e77b043040a3d07f694ce68c0c3380d622ce089`. **Staffing/landing acceptance failed;
routing and execution were observed.** Observer actions were read-only; no PC
commands or writes, bridge reconnects, lane restarts, cap changes or deploys.

| Project                           | Observed round                                                                                                                                  | Outcome                                                                                                                                                                                                                                                                                       |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| clankie                           | Head native receipts `seat-0ef7b802-011b-49a7-86e6-2a7322823c9f` at 17:16:51Z and `seat-65270db5-7ae8-4ed9-b9a1-5eb56acdfe04` at 17:46:52Z      | Correct head destination. Worker count changed 3→4. Head explicitly chose no new hires, given existing work and tight account usage.                                                                                                                                                          |
| clankie-work                      | `conv-4c11af56-0e37-4870-9294-bf307fc3c0d0`, run `run-b05fc303-8333-4991-8cd6-fbd6f6303031`, accepted 17:16:51.563Z; Auto prompt at cursor 3515 | Correct explicit owner destination. Native bridge stayed disconnected; service lane read backlog and attempted a hire. It did not stall on the bridge.                                                                                                                                        |
| kh2-multiplayer (already Auto on) | Both head rounds also listed KH2                                                                                                                | Unmatched project binding: no `trackerProjectId`, configured lead owns Linear `b701962e-89aa-4685-a574-ebda25706d64`; workspace machine `kh2` versus conversation machine `pc`. Assigned leads cannot receive other projects by workspace. No failed native delivery caused this destination. |

Clankie Work attempted Iris/LOCAL-VUH-4 at 17:20:24.649Z (cursor 3627).
At 17:20:24.650Z, cursor 3628 records
`Autonomous turns may propose a hire, not execute one`. **No worker started.**
The lead filed builtin `LOCAL-VUH-6` (`clankie-work://local/issue/24ef0c94-d2f4-4c8f-af63-595e5e2f0dcb`)
in `/Users/james/dev/tracker-research-20261008`; this is a separate builtin
tracker reference, not a Linear issue. Its 18:00 event was a scheduled self-wake
checking that blocker, not another Auto round.

Outgoing service-lead coordination reached the head at 17:18:39.537Z. Head
replies were undelivered because there was no live native channel:
[VUH-2174](https://linear.app/vuhlp/issue/VUH-2174) tracks the asymmetric reply gap.

102 samples from 16:59:14Z through the final 18:53:40Z read had zero read errors,
one ready service PID, master Auto on and both proof projects on Auto throughout.
Retained conversation/native bootstrap cursors cover the earlier start gap.
The observer's governor reported degraded CPU observation, but retained its
server permit; no enforcement override was used. It exited after the final read.

Clankie Work had zero operator messages during the window; the head had 28.
Work already assigned before the window landed, but that and ongoing owner
input cannot prove unattended Auto staffing/landing. Unchanged Work evidence
has a two-hour rewake interval, so the window contained one Work Auto round.

Private capture files remain in the task worktree's ignored
`.local/vuh-2029-two-project/`. Raw owner transcripts are not published.

| Capture                   |  Bytes | SHA-256                                                            |
| ------------------------- | -----: | ------------------------------------------------------------------ |
| samples.jsonl             | 145295 | `c4b420ee5cfb4aab5f50b75ce1f5fd113278e5ee76e4662f9e0777d3efa7e007` |
| conversation-events.jsonl | 179075 | `1ab93b6111fb3568eadc8343a3bf352d2508d186d077626e3ff01dd67c905a9c` |
| native-events.jsonl       |  78613 | `692b2c289bb7acfcf442442ead9047850e9a7744237527e3388775b07256113a` |
