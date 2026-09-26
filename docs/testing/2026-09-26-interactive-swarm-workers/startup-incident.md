# Mixed-build worker startup incident — 2026-09-26

[VUH-1380](https://linear.app/vuhlp/issue/VUH-1380), following the VUH-1377
re-vendor. The lead has held Swarm dispatch until the coordinated restart.
No production dispatch, enrollment, restart, database migration or cancellation
was performed for this investigation.

## Confirmed compatibility failure

Authenticated read-only `compatibility` requests to both live Clankie owners
returned schema **13**, revision `a7deb066`, source digest
`98f9b321b29792d930f6f674d295e7f89c4146f7b2639bf3c517ed1600e4f6bd`.
The installed vendored candidate is revision `6637756`, schema **14**.
[Sanitized descriptors](live-owner-compatibility.json) record the observation.
The npm package version is `2.0.0-rc.1` for both; that string is insufficient
compatibility evidence.

The installed `mcp-cli.js` connects, requests `bootstrap`, then checks
`assertCompatibleOwner(state.compatibility)` before serving MCP. Schema mismatch
rejects the current owner; source digest mismatch is checked separately too.
An isolated Unix-socket fixture replayed the observed schema-13 descriptor to the
**actual installed MCP executable**. It exited **1** before producing MCP stdout:

```text
swarm coordinator MCP: Owner API/schema/skill contract differs; use one candidate build and explicitly restart its owner before reconnecting
```

[Result](mixed-build-startup-proof.json) and
[fixture source](mixed-build-startup-fixture.mjs.txt) are included. The fixture
uses a dummy capability and no live coordinator or database. To reproduce, save
the source as an `.mjs` file and pass the installed `mcp-cli.js` absolute path as
its first argument. It sends only the synthetic bootstrap response and removes
its temporary socket directory afterward.

**New dispatch is not usable in this mixed state.** An old in-memory dispatcher
may launch the newly installed worker/MCP files, then encounter this startup
failure. A current dispatcher can reject earlier in `ensureCoordinator`.
Do not launch another production task merely to demonstrate the failure. This
does not imply all existing old-to-old clients have stopped working.

## Recovered worker evidence corrects the initial timeline

The lead initially reported four live MCP servers killed around 19:05Z, repeated
assignment delivery, and no lead-visible blocker. Persisted worker launch
receipts locate the native Claude transcripts. Their structured
`attachment.failedMcpServers` entries give this earlier timeline:

| Closed worker pane | First transcript entry (UTC) | Swarm `CONNECTION_CLOSED` (UTC) | Recorded Swarm tool calls |
| ------------------ | ---------------------------- | ------------------------------- | ------------------------- |
| `w2Y:p2`           | 18:45:27.255                 | 18:45:36.355                    | 0                         |
| `w2Z:p2`           | 18:50:56.449                 | 18:51:07.894                    | 0                         |
| `w20:p2`           | 18:50:57.614                 | 18:51:08.631                    | 0                         |
| `w31:p2`           | 19:04:19.668                 | 19:04:25.831                    | 0                         |

These errors appear 6–11 seconds into each transcript. Earlier workers
`w2T:p2`, `w2V:p2` and `w2W:p2` recorded Swarm tool calls and no such structured
connection-failure attachment in the inspected transcripts. Absence of an error
attachment does not establish their present health.

[Sanitized timeline](startup-incident-timeline.json) includes source transcript
hashes, timestamps, counts and the exact connection error. It omits assignment
content, lease tokens, capabilities and raw transcripts. The four failed workers
have no recorded Swarm tool use: the evidence supports **dead-on-arrival MCP
startup**, not a demonstrated loss of previously healthy MCP connections.
Claude's lead accepted this timeline correction.

No matching per-worker files remained under `~/.claude/debug`, and no `.log`,
`.err` or `.out` worker files were found under `~/.clankie/swarm`. The wrapper
inherits Claude stderr into its pane rather than persisting it. Those panes have
been closed by their owner. The surviving transcripts report only the transport
closure, not its process exit cause. The isolated compatibility reproduction is
consistent with startup rejection, but does **not** prove the original four
processes exited for that exact reason. Package-file replacement alone does not
prove an already-loaded process was killed.

## Why reported binding and renewal were misleading

Source inspection at upstream `6637756` shows:

- `herdr-worker-cli.ts` writes `started: true` before spawning Claude, independently
  connects its coordinator client, and publishes `available` without MCP readiness.
  Each Claude `result` publishes available again; observer errors go to stderr.
- `herdr-dispatch.ts` accepts the launch receipt, a pane lookup and an available/busy
  session observation. `DispatchTransaction.bind` then claims the task on the
  worker's behalf. That claim does not prove a worker MCP call succeeded.
- The wrapper's 15-second task-renewal loop is independent of Claude MCP health.
  `renewTaskLeases` ignores `stale_attempt`; renewals do not constitute progress.
  Existing task renewal is bounded by the separate progress/cancellation deadline.

Thus the wrapper can stay connected and deliver more context while the harness
cannot acknowledge it or send a blocker. Pane existence, renewed ownership and
`bound` are not sufficient evidence of usable worker tools in the current design.
An uncertain cancel must remain uncertain until stopped execution is established.

## Agreed prevention design

[ADR 0194](../../adr/0194-interactive-swarm-workers-receive-leased-channel-events.md)
now requires authenticated worker MCP readiness **and a verified task claim**
before successful `bound`/`started`, typed startup failures, independent wrapper
`blocked:mcp_disconnected` reporting, coordinator-side progress alarms, and an
upgrade preflight/admission barrier with immutable runtime generations preferred.
These are design requirements, not shipped safeguards. The current operational
hold and coordinated backup/restart window remain necessary.


## Verification of this evidence change

The live compatibility queries were read-only. The actual MCP candidate failed
against the isolated old-owner descriptor with the recorded exit and stderr.
Owned-file formatting and all 378 local Markdown link checks pass. Full
`pnpm check` now stops at one unrelated formatting file,
`docs/testing/2026-09-26-pi-startup/flows/prove.mjs`; the previous 24 work-items
formatting blockers have been resolved by their owner. See the
[captured check output](startup-incident-check.txt). No unrelated files were edited.
