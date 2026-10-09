# Simulator task holders and exact-device acquisition (VUH-1888)

The operator reported that native Claude children shared a seat-level lease:
a requested iPhone returned the sibling's iPad. Two independent gaps explain
how that can happen: missing Bash holder metadata falls back to the root seat,
and concurrent acquires under one holder previously shared the first request's
result without checking the second request's exact selection. Existing lease
reuse also ignored exact model/runtime changes.

## Source correction

- Fresh acquire/plan requests require a stable task holder; missing hooks refuse
  with a repair hint. Legacy holderless leases retain their original cleanup
  identity.
- Claude's real Bash hook derives session/agent identity in a subshell and clears
  an ancestor Codex thread. Its export cannot persist into sibling Bash calls.
  Codex prefers the executing native thread over an inherited parent holder;
  explicit owned task arguments retain precedence.
- Acquires serialize per holder, then validate each request's device, exact model
  and runtime. Incomplete boot reservations remain pollable; completed grants
  are checked again. A holder requesting a different device is refused with its
  existing lease/device identified. Busy explicit UDIDs wait without selecting
  an idle alternative, with the actual blocking holder named.
- The CLI validates acquired responses against holder and exact selection,
  including responses from an older or incorrect service.
- Worker plugin 0.6.11 gives the changed hooks a fresh cache version. Doctor and
  native installation verification require the resource Bash hook alongside
  lifecycle hooks. This source change does not reload an existing session.

## Device-operation decision

Install, launch and drive clients should check the task holder per device.
The API and CLI now expose a read-only preflight:

```sh
clankie simulator verify '{"seatId":"SEAT","id":"LEASE_ID","deviceId":"UDID"}'
```

It checks native occupant/process proof, holder, lease, exact UDID and confirmed
booted state. It neither acquires nor renews a lease. Abort the device action
when refused. Clankie cannot intercept independent raw simctl, Xcode or external
MCP commands, or hold an atomic lock through them. This is a usable preflight,
not system-wide enforcement against arbitrary shell access.

## Checks

[Structured checks](checks.json) preserve per-case outcomes without private logs.
The full simulator file passed 33/33 and authenticated route file passed 18/18
(98.30 s combined). These exercise real TCP, durable journal/process proof and
child-process native adapter boundaries: exact busy-device selection with an
idle alternative, concurrent different exact requests, sibling denial,
missing-holder refusal, boot polling and cleanup, grant validation for wrong
UDID/holder/model/runtime, and verify through the source CLI/API.

CLI heavy tests passed 10/10 and profile inspection tests passed 9/9. The native
harness-refresh file passed its source inspection case and skipped its explicit
manual native-install case. Four package typechecks, targeted formatting/lint
and doc checks passed. Later focused checks cover the exact-device wait hint;
reuse the earlier complete results for unchanged behaviors.

Earlier runs exposed a valid boot poll rejected before device metadata was
assigned (fixed with post-preparation validation), an inherited Codex thread in
the synthetic Claude CLI fixture, an inconsistent iPad request carrying iPhone
model constraints, and a wrong-UDID client fixture that had not requested a UDID.
The corrected fixtures and final results are recorded, rather than counting
those earlier failures as acceptance.

## Live scope and activation gaps

[Live receipts](live.json) record two throwaway native-subagent-style Codex thread
holders, both inheriting a parent holder. The source CLI derived distinct holder
IDs and polled the exact existing iPhone for about three minutes. Both stayed
`waiting (simulator_capacity)` behind the app's `vuh-1875-ipad` lease. No fresh
sibling grant was returned. No new simulator was created, no app lease was
released or driven, and cleanup confirmed zero owned leases. The existing app
lease and one-slot budget remained in place; normal app heartbeat changes are
visible in the before/after snapshots.

This is a source-client check against the installed service. The occupied pool
prevented a live positive grant/handoff; positive grant, sibling refusal and
verify behavior are covered across the real fixture boundaries above. The new
manager/verify endpoint and plugin changes require normal deployment/setup.
No deploy, seat restart, live settings write or other worker process mutation
occurred.

[Profile snapshot](installed-profile.json): the operator initially reported an
unset Bash holder and a 0.6.10 cache without the resource hook. A later read-only
inspection found the hook and file now present in `.claude-james` 0.6.10. The
current on-disk absence claim is therefore unsupported; an existing session
using older cached hook definitions remains possible. No extra native model
child was spawned and no hook reload was forced. Keep the app subagents' explicit
holderIds until their operator verifies native hook activation.

[Owned runner](live-runner.ts.txt) is archived for review, not automatically run.
