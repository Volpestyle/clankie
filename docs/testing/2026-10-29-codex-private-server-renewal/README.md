# Detached Codex server renewal — VUH-2969

Baseline: `0f78a463ad889ac2a1ced0a912014b4887eaa1a2`.
Captures: `private-server-captures.tar` in [the manifest](./evidence.json).

## Cause

Live ticket `f2a7956a` had the same `codex:01a185b6-…` holder as lease
`3ddded9d`; `w48:p5F` was only its seat alias. Queued tickets were already
included in the lookup. A fresh read-only native proof instead exposed a missing
process relationship: the foreground TUI was PID 84570, while commands descended
from original registered app-server PID 76294/birth 1793244659.570815, detached
under PID 1. Its command ancestry never reaches the foreground TUI named by the
lease. The original launch record and current foreground proof agree on pane,
native occupant and binding.

`live-owner-ancestry.json` records this current observation. The old queued PID
14124 had exited; its historical edges were not measured. The captured launch
path, retained native server birth and scratch reproduction establish the
topology defect without claiming a historical ancestry sample.

The service now joins observed command ancestry through the existing
`LocalCodexSeats.allows` original-registration proof, also used for private tool
admission. Exact task holder, local pane, binding and native occupant still
match; original server births and restored occupants are re-observed. Every
command ancestry edge and the foreground's live birth are rechecked afterward.
No alternate authority is persisted in a lease or supplied by a caller.

The host registry read runs outside simulator mutation serialization. A heavy
sample has a ten-second apply bound and retains its observation timestamp, so a
late result cannot extend activity from its later application time.

## Source checks

All checks used `clankie heavy` and scratch HOME.

- `detached-red-registered.log`: unchanged baseline expires a lease while its
  matching ticket is queued. The fixture uses the live terminal/pane alias
  shape, a real separate foreground process, detached backend and restored
  durable original launch registry.
- `detached-green.log`: that case passes after the join, including held-work
  retention, idle expiry and copied-label denial outside the backend ancestry.
- `detached-host-probe-red.log`: an intermediate implementation that awaited
  the new registry read inside serialization returned `held` for release while
  that read was paused. The final repair keeps this read outside mutations.
- `detached-focused-final.log`: **83/83** across resource-wait liveness,
  simulator integration, existing private-Codex registry controls and service
  fixture isolation. Includes the paused-membership release boundary and the
  prior native-read release/coalescing controls.

HTTP, process births, command ancestry, durable registry and governor state are
real. Native harness discovery and simctl are surrogates. The fixture backend
has a separate process group and shares a parent with its separate foreground;
the live backend is under PID 1. Neither has the foreground in its ancestry.
This is source evidence, not the required deployed queue-only recheck.

## Remaining live acceptance

The earlier interrupted live proof is
`clankie://evidence/sha256/5da56b99206590d1cbf181ec9e4672ed9a7917df38675d33adda33e63519e299`.
It retained the lease for 660.844 seconds queued, but expired only 238 seconds
after target release. This patch addresses the newly reproduced missing native
server association. The lead deploys after exact review/gate, then authorizes
one isolated queued-ticket window and prompt-idle expiry. No new live blocker,
simulator action or worker service restart was performed for this follow-up.

The landing gate runs in the normal worker environment; the repository's
`scripts/testing/vitest-setup.ts` isolates each test file's HOME and stores.
Overriding HOME for the entire gate hides worker review identity. Per the lead,
that gotcha remains in issue evidence for the next skill update.
