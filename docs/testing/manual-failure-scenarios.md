# Manual trust and delivery checks

[VUH-1522](https://linear.app/vuhlp/issue/VUH-1522) is a James-triggered checklist.
No scenario, model call or eval runs through CI, `pnpm check` or release gates.
This document defines checks; it records no completed run.

Use disposable conversations, services, panes and test accounts. Record the
actual service, bridge and client revisions, selected conversation, native
occupants and UTC times. Give each action a unique `VUH-1522-CASE-RUN` marker;
retain original dispatch IDs. Faults affect only the test-owned process/link.
If an injection or observation is unavailable, record that gap rather than a pass.
Never manufacture success from a tool return or silently retry an uncertain write.

## Incidents from 2026-10-04

### Q — Hung turn queue ([VUH-1613](https://linear.app/vuhlp/issue/VUH-1613))

Hold one cold preparation dependency unresolved in a disposable service, before
any tool starts, while its event loop remains live. Record the held dependency
and phase; pausing the whole process cannot test its watchdog. Admit marker Q0,
queue Q1–Q9, then attach a native seat to that conversation. After five minutes
without progress, inspect its run journal and service log: Q0 must fail with
`conversation_turn_stalled`, naming conversation/run/phase; all nine later inputs
must become available to the seat. Release the held dependency: Q0 must not prompt
or publish a late result. Control: a bash `sleep 360` with a seven-minute tool
timeout must survive six silent minutes, then get a fresh five-minute idle window.
The incident's exact hung dependency remains unidentified; do not claim this
controlled check identifies it.

### D — Private descriptor overwrite ([VUH-1631](https://linear.app/vuhlp/issue/VUH-1631))

In a disposable HOME, start a baseline service using its default state and record
the SHA-256 of `~/.clankie/links/default-local.json`. Through its existing worker
bridge, perform one connected read. Start a second service with a distinct
absolute `CLANKIE_STATE`; repeat the hash/read after boot, normal close, and a
separate startup failure after publication. Pass only if baseline bytes and
the worker's route survive every stage. The private descriptor belongs under
`<CLANKIE_STATE>/links`; remove only that test-owned descriptor and retry private
discovery: it must fail, never fall back to the baseline. Retain hashes and route
identity, never descriptor credentials. Do not reproduce against the live shared service.

### R — Effect succeeded, receipt lost ([VUH-1638](https://linear.app/vuhlp/issue/VUH-1638))

Use one test worker and a controlled upstream MCP link. Send one marked
`message_seat`; after native admission, cut the upstream connection before its
reply and reconnect the same operator bridge. Repeat separately for one hire,
and for one comment on a test Linear issue after the provider records the write.
Inspect the recipient, fleet and provider independently: exactly one effect.
Native calls must return the original receipt or typed uncertainty with its
original `deliveryId`/`hireId`; use `reconcile_seat_call` with that ID, never a
replacement send or terminal typing. A Linear read must find exactly one marked
comment even if the caller lost its response; do not infer rollback or resend.
A bare `Connection closed` after a known effect fails the receipt check even
when the one-effect check passes. Retain bridge generation/pending/close events
and provider IDs. The reproduced shared-client close race does not establish the exact trigger of every live
`Connection closed` incident.

### S — Successful response rejected ([VUH-1635](https://linear.app/vuhlp/issue/VUH-1635))

Use a new-host roster containing `harnessBridge` and
`subagents.recent.{id,startedAt,endedAt}`. Feed it to the old `c4b9bd53` response
schema: retain the expected `unrecognized_keys` rejection after HTTP 200. With
updated client readers, force gateway-only access (no usable direct route) to a
20-seat fixture and compare seat IDs/statuses with the direct roster and app
contacts. Pass requires equality on both iPhone and iPad. Separately corrupt one
known field's type and submit an unknown request field: both must still reject.
Record the app's bundled revision; a newer host cannot repair an installed strict
client. The older-schema reproduction does not identify the phone's exact bundle.

### L — Writes through shared dependency links

Today's task dependency links could write into shared trees; missing Mac Skia
`libs/macos` was reported afterward, without a proven deleting operation.
Before any task install/build, inspect every symlink under its `node_modules`,
`.vite` and build caches, including `.pnpm`, `.bin` and individual package links.
Resolve targets: none may enter a shared checkout. Retain the audit and
hash/existence of selected shared package files, including Skia `libs/macos` when
present. Run a real isolated install/build, then repeat those observations:
shared files must be unchanged and all task dependency/cache writes local.
Never create the forbidden shared link as a reproduction; use a real install or
local copies. Internal links wholly inside the task checkout are allowed.

### P — Unadopted report goes to the wrong lead ([VUH-1615](https://linear.app/vuhlp/issue/VUH-1615))

Use a real parent-launched worker with no persisted hiring/adopting owner, first
local, then remote with fleet-qualified IDs. Record census `parentSeatId` and
exact native sessions. Have the worker send one marker through `message_clankie`: only its
eligible linked parent channel or attached conversation receives it. Adopt it
from another conversation with host-admitted `message_seat`; a new report must
route there. Separately remove the test parent's bridge: fallback must have a
durable reason in `global-default`, and doctor/roster must name parent and child.
Replace the parent or reporter while route discovery is held: refuse before
acceptance. Reconcile an already accepted report after adoption/restart: its
original ID/destination stays fixed, with no replay or delivery to a replacement
occupant. Titles, tabs and ancestry must never grant room tools.

## Remaining VUH-1522 boundaries

Each row uses the same disposable setup and marked evidence. Observe journals
and actual external effects; an assistant's assertion alone cannot pass.

| Case                                     | Manual action                                                                                                                                                                                                | Observable pass condition                                                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F — stale authority and restart mid-task | Hold a worker report after acceptance; restart the test service and replace its native session. Try the old session's take/ack/report, then inspect fleet and original receipt.                              | Stale occupant refuses; original delivery is never replayed to the replacement. Fleet reports actual surviving, absent or uncertain work.                                        |
| C — peer chatter                         | Allow two test workers three marked exchanges with no new information; inspect traffic, then run `clankie fleet set --peer-messages off` on the test service and attempt a stale-catalog send.               | Record any autonomous stop and its reason. No visible stop is a gap, not an invented policy. The switch must refuse new sends; existing uncertain receipt reads remain possible. |
| M — social privacy                       | Store a synthetic `operator_private` marker in the owner's test conversation and verify owner recall. From an untrusted guild friend, ask for that conversation and marker.                                  | No private marker, summary or machine tool appears in the social reply; owner recall still works.                                                                                |
| E — Discord echo                         | Post one marked worker webhook message in a test channel; observe its Gateway return. Then send one ordinary human control message.                                                                          | Webhook return causes no reply loop; the permitted human message still reaches Clankie.                                                                                          |
| W — Linear echo                          | Follow a test issue with `ownerUserIds` set, connected-app/worker selectors off. Write one marked comment through Clankie and deliver its signed webhook/notification; repeat with a configured owner human. | Self echo causes no accepted wake; eligible attributed human event wakes its owning conversation once. Unknown attribution stays quiet. See ADR 0214.                            |
| H — head-seat switch                     | In one test conversation, record a synthetic memory marker and persona/card; detach Claude, attach Codex to the same conversation and ask for them.                                                          | Identity and authorized memory carry; one attached driver, no extra conversation or cross-room grant.                                                                            |
| I — voice interrupt                      | In a trusted test voice room, begin speech while a separately marked worker task runs; a person interrupts.                                                                                                  | Speech stops; the task's own progress/receipt continues without cancellation or duplicate dispatch.                                                                              |
| A — voice attribution                    | Have two people overlap the same machine-tool request in a trusted test room; follow with a clearly attributed authorized speaker's harmless control request.                                                | Ambiguous speech executes no machine tool; the authorized control remains capable. Retain speaker-attribution and tool events.                                                   |

## Run record

James runs the cases once on his Mac and retains dated evidence under
`docs/testing/YYYY-MM-DD-trust-delivery/`. For every case record `pass`, `fail`
or `unavailable`, the exact setup/action, original IDs, timestamps and artifact
paths. Redact private content and credentials; private app/hosted evidence stays
in its owning repo. Link existing incident issues for matching failures and file
distinct failures separately under VUH-1522; do not fix them inside this checklist.
Missing injection, receipt, physical-device or attribution proof stays open.
