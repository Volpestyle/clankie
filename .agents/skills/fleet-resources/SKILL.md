---
name: fleet-resources
description: "Run heavy commands and lease simulators in Clankie's local native fleet. Use for builds, typechecks, test suites, installs and owned runtime instances, or when inspecting a resource wait."
---

# Share the machine

Run heavy work through the shipped command:

```sh
clankie heavy -- pnpm --workspace-concurrency=1 --filter @clankie/clankie typecheck
clankie heavy -- pnpm exec vitest run path/to/relevant.integration.test.ts
clankie heavy -- node path/to/owned-runtime.js
```

Keep the complete owned runtime and its children inside the wrapper's lifetime.
Each permit passes `VITEST_MAX_WORKERS=4` and `TURBO_CONCURRENCY=4` to its
children, including package scripts and nested commands, preserving lower
positive integer environment limits.
Under `clankie heavy`, inherited `VITEST_MAX_WORKERS` beats `--maxWorkers`; set the environment variable to a lower value to reduce parallelism.
Turbo tasks must pass these variables
through strict environment filtering (this repo's `turbo.json` does).
Do not override Turbo's limit with a higher `--concurrency` or `--parallel`.
These tool-native limits do not restrict arbitrary subprocesses or CPU affinity;
serialize compilers and other tools that do not honor them.
Serialize multi-package compilers inside one permit.
`clankie heavy` sizes the command for you. Vitest naming up to eight test files,
`tsc` without `--build`, or `pnpm --filter ONE typecheck` runs in the light lane:
two cores, its own slots, held only by the memory floor, so it starts beside full
gates. Name the files rather than a directory, and don't wrap a focused check
in `sh -c`; either makes it a full job. An optional `--seat LABEL`
before `--` labels the seat in status; `--holder ID` identifies its native child. Neither grants seat authority. Arguments
after `--`, including flags such as `--chat`, belong to the child. The wrapper
preserves its exit status and forwards interruption. Nested commands with the same holder in the same
verified process group reuse its permit. Once your command exits, anything it
left in its process group (a test's server, watcher or fixture) is a leftover:
status shows the lease as `leftovers`, or `orphaned` if its runner died. After a
ten-second grace the runner, or the governor for a dead runner, sends the group
SIGTERM, then SIGKILL after five more seconds, and frees the slot. What it
stopped (process names and signals, never arguments) is recorded in
`leftovers.jsonl`; the released lease, in `reaped.jsonl` when its runner died.
Stop helpers in your own teardown anyway: a leftover is killed, not drained.
A lock-helper fault before the journal write committed nothing and is retried
on a fresh helper, so a queued job does not die from it.

`clankie fleet resources` and `clankie doctor --json` show capacity, actual holders,
queue and pressure. Status includes executable names and labels, never arguments
or credentials. A wait can mean a full pool, high load, low available memory or
unavailable native observations. macOS available memory matches
`memory_pressure -Q` through the kernel's compressor-aware percentage; Linux
uses `MemAvailable`. macOS pressure reads share a one-second cache, then refresh;
failed observations refuse new local hires without terminating existing agents.
A local hire is refused only when available memory is below its floor or the
observation fails; high load admits it, and its receipt's `resourceNotice` says
its heavy work and simulator leases will queue until load drops.
Python 3 and the shipped native helper
must be available. Repair an unavailable installation through the existing setup
route; do not select another registry to evade a wait.

Brief journal-lock contention waits internally and keeps the heavy request's
queue ticket. Its transaction deadline begins only after lock acquisition.
An actual helper failure reports the exit/signal and native exception type or
errno; retain that exact error for diagnosis rather than changing capacity or
resubmitting a healthy queued request.

The owner sets capacity through `clankie fleet set --heavy-slots auto|N` and
`--simulator-slots auto|N`, or `/fleet resources`. `heavySlots` is a ceiling
(automatic: one per two cores and per 12 GiB, nine on the 18-core, 128 GiB Mac).
One job per four cores (four here) runs on the load and memory guards alone, as the
[alternating benchmark](../../../docs/testing/2026-10-08-heavy-parallelism/README.md)
supports. Each job above that starts only while the measured machine (the busier
of load and kernel CPU, plus a full four-core share for every job admitted in
the last minute) stays under 70% of the cores, with memory to spare. A wait
that names `busy` is this rule; `slots` is the ceiling. Task-specific owner budgets still bind;
a source/default change does not authorize increasing live capacity.
Heavy and simulator leases have independent budgets. Automatic simulator
capacity gives simulators half the machine at the measured cost of one
simulator under test (34 GiB footprint, two cores): one on the 18-core, 128 GiB
Mac, where memory, not CPU, binds. Load and available-memory guards gate both. A cold boot burns about ten
cores for two minutes, ahead of the one-minute load average, so the governor
admits no new simulator within three minutes of the last one and answers
`waiting` with reason `pressure`. Keep the blocking request open
([measurements](../../../docs/testing/2026-10-09-lean-simulators/README.md)).
The registry belongs to the OS account and is shared across worktrees. Worker
`HOME`, state-path or `HEAVY_SLOTS` overrides cannot increase capacity.

# Lease a simulator

Boot simulators only through `clankie simulator acquire`. Never `xcrun simctl
boot`, Simulator.app or a test runner that boots its own device: a device
booted outside a lease holds one of the fleet's simulator slots, and other
lanes wait on it. Use the owner-authorized CLI from an existing proven local
native seat; the host observes the seat's occupant and process identities.
Follow any task-specific owner approval before acquiring.

```sh
clankie simulator acquire '{"seatId":"SEAT","deviceType":"com.apple.CoreSimulator.SimDeviceType.iPhone-17","runtime":"com.apple.CoreSimulator.SimRuntime.iOS-26-0"}' --wait 600
clankie simulator status
clankie simulator touch '{"seatId":"SEAT","id":"LEASE_ID"}'
clankie simulator release '{"seatId":"SEAT","id":"LEASE_ID"}'
```

Acquire/plan require a stable task holder: a missing native hook now refuses
instead of silently borrowing a seat-level lease. Explicit owner calls outside a
native harness must supply their own `holderId`. Older holderless leases remain
releasable through their original root identity.

Acquire takes one persisted FIFO ticket and blocks on the service, by default
for up to one hour. Its request-scoped headers/body timeout covers that whole
wait, rather than the HTTP client's five-minute default. A transport failure names
its native cause and leaves the ticket resumable with its original FIFO position
until stale expiry; check status, then resume or cancel explicitly. A disconnected
wait stops waiting without admitting another effect. `--wait SECONDS` bounds that single request (0 returns the
ticket immediately); it never repeats acquire HTTP calls. Use `fleet resources`
to see the holder, resolved target, per-device queue position and estimated wait.
The estimate uses the current lease's remaining idle budget and queued rounds;
heartbeats can extend it. Pressure or insufficient information reports a null
estimate, never a promised deadline. A matching model request resolves an existing
device even if busy; exact UDIDs never substitute or create a replacement.
The queue persists across service restarts. Waiting calls renew their ticket's
five-minute stale deadline; after a bounded wait ends, use the same selection and
`ticketId` to resume before expiry, or cancel it explicitly:

```sh
clankie simulator cancel '{"seatId":"SEAT","holderId":"TASK","id":"TICKET_ID"}'
```

Only that live seat/occupant/holder can cancel. Cancel before changing the ticket's
selection. Dead native owners and expired tickets leave the queue; unknown native
observations do not prove an exit. Heavy ordering and unrelated device queues
remain independent. A queued device is not a lease and grants no driving authority. Acquire is idempotent per seat, occupant and holder for a matching selection.
Changing the device or exact model refuses while that holder has a different lease;
concurrent requests validate their own selection instead of sharing another grant. Native Claude Bash hooks supply a session/subagent holder;
Codex uses its executing thread ID even when a parent holder is inherited. The
Claude hook scopes its identity to a subshell and clears an ancestor Codex thread.
`clankie doctor` detects an installed worker plugin without the resource Bash hook;
refresh that linked profile with the approved harness setup route. Installing a
new hook does not update an existing session that has cached hook definitions. Status names `holderId` beside the seat. A child cannot
touch or release a sibling holder’s lease. Other harnesses must supply a stable
`holderId` in every simulator request (including touch/release), and `--holder ID`
for heavy commands. `CLANKIE_RESOURCE_HOLDER` supplies the identity outside Codex; a Codex thread
takes precedence. An explicit simulator `holderId` or heavy `--holder` overrides
that automatic choice for an owned task. These labels do not grant seat authority. Never choose your lead’s or a
sibling’s identity. Outcomes:

- `acquired`: use `lease.deviceId`, the exact UDID, for every simulator command.
- `booting`: the service is creating or booting your device and keeps going if
  you stop waiting. The blocking acquire waits for it; a bounded request can resume its matching lease.
- `waiting`: every slot is held. `hint` and `blockers` name the seats holding
  leases, devices booted outside leases (and the seats whose processes use
  them). Heavy commands use their own budget. Keep the blocking request open; inspect its persisted ticket, or ask the named holder to release.
- `rejected`: `reason` is the cause. `service_restarting`: retry shortly.
  `owner_unavailable`: your seat's live occupant could not be proven; `detail`
  names why. A failed observation (common under load right after a service
  restart) is retried, and a waiting acquire keeps its ticket through two
  minutes of them, so retry the same request; no re-adoption is needed. A
  changed occupant or exited process refuses at once.
  `device_unavailable`: the type or runtime is not installed; pick one of
  `alternatives`.

Acquire prefers an idle existing device of the requested type, then a close
model of the same screen, then another idle iPhone or iPad of the same family
on that runtime. `lease.requestedDeviceType` says one stood in; pass
`"exact": true` to require the exact model. It creates only when no suitable
idle device exists. The CLI reads a plan before acquire and warns when that
plan needs a new device: its first boot can be expensive and slow the Mac.
`clankie simulator plan JSON` reads that advice without reserving or booting.
The plan is advice; acquire rechecks availability and authority before effects. If you already booted a device by hand, lease it instead of booting
another: `clankie simulator acquire '{"seatId":"SEAT","deviceId":"UDID"}'`.

Within the requested family and runtime, a valid native `lastUsedAt` timestamp
puts previously booted devices ahead of devices with unknown boot history,
even when the latter match the requested model exactly. Among those candidates,
exact model then close model then family determines preference. `exact: true`
never substitutes a different model; an explicit `deviceId` remains strict.
Missing or malformed metadata is unknown, never proof of a previous boot.

Before installing, launching or driving a device, verify its lease with the same
holder. This read-only preflight checks the live occupant, holder, lease and exact
UDID, and requires a confirmed booted device:

```sh
clankie simulator verify '{"seatId":"SEAT","id":"LEASE_ID","deviceId":"UDID"}'
```

A successful verification describes the existing owned lease; it acquires nothing
and does not renew its heartbeat. Abort the device operation if verification
refuses. Raw `simctl`, Xcode and external MCP tools are outside this API; the
preflight cannot prevent a separately issued raw command or hold an atomic lock
through it. Those clients must perform the check before their device operation.
Never drive a sibling's device just because its UDID is visible in status.

Read `usage` beside `holderId` in `clankie fleet resources` or
`clankie simulator status` for that device's runtime cost. Kernel footprint
includes private compressed memory; summed RSS includes shared pages and must
not be described as physical RAM used. Interval CPU uses 100% for one core;
process exits between observations can undercount it. Partial or unavailable
samples do not mean zero. Diagnostic samples never grant device authority.
Whole-machine admission includes these costs and bounds Darwin's memory estimate
by free and file-backed pages; do not subtract a device's charge a second time.

Touch the lease while actively using it; its default idle timeout is ten
minutes. Release when finished; it answers within about twenty seconds. A
reservation that never started its device is released at once; `held` with
`retryAfterMs` means a native boot or shutdown is in flight and the release
settles it, so read status after the retry rather than releasing again. A
reservation that starts no device within five minutes frees its slot by itself.
Release, idle expiry or a verified seat exit
shuts the leased device down and keeps it for later reuse, including devices
Clankie created. Deletion requires a separate, explicit owner tidy naming the
exact stopped UDIDs; release and expiry never delete devices. Clankie
never shuts down a device it did not lease; it names such devices
in status and doctor and tells the lead of the seat using one. Never run
global shutdown, erase, delete-all or unavailable-device cleanup for fleet
work.

A missing or uncertain create receipt remains held for operator review. Do not
retry native create or infer ownership from a device name. A stopped observer
preserves leases. Status and the original journal distinguish a held receipt
from successful cleanup.

Run resource stress checks only manually or in the release gate. Personal-repo
push and PR checks remain fast and scoped; evals remain explicit manual runs.
