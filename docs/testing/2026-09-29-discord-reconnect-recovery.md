# VUH-1447: Discord reconnect recovery

## Result and scope

Offline regression checks exercise policy-matched catch-up, persistent activity,
and reply delivery after restart. Separate coverage exercises a disconnected
Swarm MCP transport and degradation of the operator tool bank. Fixtures use
synthetic text. No private Discord message bodies were inspected or copied.
No service restart, live Discord send, or push was performed for this change.

## Content-free incident evidence

Read-only queries of the local delivery database found the affected channel's
cursor at `1554562677035110606`, beyond message `1554538842218958896`.
The target had no delivery row and no match in `discord-live-receipts.jsonl`.
Code confirmed the scan only admitted explicit addressing, whereas live ingress
also admitted unaddressed messages in channels where Clankie had replied.

`discord-bridge.log` contained 1,068 `gateway_reconnecting` transitions at the
initial inspection. Between 15:00Z and 19:00Z on September 29 there were 14;
13 ended in `gateway_ready`, one in `gateway_resumed`. These transitions alone
do not record the low-level close reason, heartbeat ACK state, or replay count.

macOS `pmset -g log` identifies the host outage:

| UTC          | Evidence                                               |
| ------------ | ------------------------------------------------------ |
| 16:56:06     | DarkWake from Deep Idle                                |
| 16:56:09.321 | Gateway reconnect                                      |
| 16:56:11.165 | Gateway READY                                          |
| 16:57:06     | Sleep Service Back to Sleep, duration 857 seconds      |
| 17:02:21     | Reported message timestamp, inside that sleep interval |
| 17:11:23     | DarkWake from Deep Idle                                |
| 17:11:23.407 | Gateway reconnect                                      |
| 17:11:27.790 | Gateway READY                                          |

For all 14 reconnects, the signed seconds from the nearest OS wake were:
`0.648, 0.876, 35.754, 0.826, 0.312, -0.332, 2.484, 3.321, 0.407,
0.445, 0.476, 1.432, 0.434, 33.352`.
The OS log has whole-second timestamps; 12/14 are within four seconds.
The remaining two follow wakes by 33–36 seconds. This identifies host sleep
as the dominant cause of this window's churn, not benign Discord maintenance.
It does not prove every historical reconnect has the same cause.

Vox's `clankvox_audio_tick_slippage` warnings come from its separate Rust process;
resuming from sleep explains nearby ticks without establishing a Node stall.
The bridge uses default discord.js gateway configuration. The installed gateway
implementation reconnects on missing heartbeat ACK (`Zombie connection`),
server reconnect requests, and socket closes; old logs do not distinguish them.
New allowlisted diagnostics report those lifecycle facts and maximum Node loop
delay, without logging arbitrary discord.js debug output or credentials.

## Recovery behavior

History invokes the live admission function. The bounded channel activity map
and live attention counter persist in `channel_activity`; pending messages
remain in `deliveries`. A prior page bootstraps activity for older installations,
and own messages in scanned pages establish it before later follow-ups.
The scan still honors guild/channel/DM trust and the configured reply policy.
A transient reply-reference fetch failure leaves the scan cursor unchanged.

The bridge cannot receive events while its host sleeps and does not override
system/lid sleep. The fix makes eligible offline messages recoverable on wake.
Already-advanced cursors are not rewound; this patch does not resend the incident
message. History older than the single bootstrap page may require separately
establishing channel participation on an upgraded installation.

## Verification

`pnpm check` passed on September 29, 2026 (exit 0): formatting with oxfmt,
lint, dead-code checks, docs, infrastructure, 28 typecheck tasks, 360 Vitest
files with 3,061 tests passed and 2 skipped, 123 Rust tests passed, and Vox
IPC smoke ready. Full local output: `/tmp/vuh-1447-pnpm-check-final.log`.

Focused checks also passed:

- Discord inbox, gateway diagnostics, and shared ingress: 61 tests at the first
  focused checkpoint. The final inbox suite has 14 passing tests, including the
  additional check that scanning an old reply preserves live attention.
- Final inbox, lane MCP, and real Swarm integration suites: 31 tests passed.
  The HTTP regression initializes an operator MCP session successfully and lists
  `hire_agent` while Swarm throws `Not connected`; another test closes a real MCP
  transport and obtains tools from a newly opened connection.
- Restart scenarios cover saved participation, a prior-page reply, and a reply
  in the scanned page. Each replays a synthetic unaddressed follow-up through
  ingress and observes a reply after reopening the journal. Other cases cover
  the `all` policy, unknown rooms, a denied guild, drifted attention, pagination,
  reconciliation, and a transient reference lookup failure.

An earlier full run passed 3,060 tests but failed test cleanup with `ENOTEMPTY`
while removing a temporary Swarm coordinator directory after SIGTERM. Bounded
filesystem-removal retries address that teardown race; the subsequent full run
passed. This was not a production gateway or Swarm assertion failure.

The separate Swarm fix is commit `c2c2f401`. The report's containing commit holds
the Discord change. Both are local on `main`, awaiting the lead's push.

## Live checks remaining

The lead owns push and service restart. After deployment, verify an unaddressed
follow-up sent across a gateway outage gets ingress and reply receipts; verify
activity survives a bridge restart and inspect the new gateway diagnostics.
No actual Discord replay or Claude-seat reconnect was exercised by these fixtures.
