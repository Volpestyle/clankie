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
positive integer environment limits. Turbo tasks must pass these variables
through strict environment filtering (this repo's `turbo.json` does).
Do not override Turbo's limit with a higher `--concurrency` or `--parallel`.
These tool-native limits do not restrict arbitrary subprocesses or CPU affinity;
serialize compilers and other tools that do not honor them.
Serialize multi-package compilers inside one permit. An optional `--seat LABEL`
before `--` labels the seat in status; `--holder ID` identifies its native child. Neither grants seat authority. Arguments
after `--`, including flags such as `--chat`, belong to the child. The wrapper
preserves its exit status and forwards interruption. Nested commands with the same holder in the same
verified process group reuse its permit. Detached surviving children retain the
permit until the kernel proves they have exited.

`clankie fleet resources` and `clankie doctor --json` show capacity, actual holders,
queue and pressure. Status includes executable names and labels, never arguments
or credentials. A wait can mean a full pool, high load, low available memory or
unavailable native observations. macOS available memory matches
`memory_pressure -Q` through the kernel's compressor-aware percentage; Linux
uses `MemAvailable`. macOS pressure reads share a one-second cache, then refresh;
failed observations refuse new local hires without terminating existing agents.
Python 3 and the shipped native helper
must be available. Repair an unavailable installation through the existing setup
route; do not select another registry to evade a wait.

Brief journal-lock contention waits internally and keeps the heavy request's
queue ticket. Its transaction deadline begins only after lock acquisition.
An actual helper failure reports the exit/signal and native exception type or
errno; retain that exact error for diagnosis rather than changing capacity or
resubmitting a healthy queued request.

The owner sets capacity through `clankie fleet set --heavy-slots auto|N` and
`--simulator-slots N`, or `/fleet resources`. Automatic capacity is the smaller
of one slot per four cores and one per 24 GiB RAM, with a minimum of one.
The 18-core, 128 GiB Mac therefore defaults to four permits when this version
is installed. The [alternating benchmark](../../../docs/testing/2026-10-08-heavy-parallelism/README.md)
finished its four-job batch about 30% sooner with four capped jobs. Its busy-machine
load peaks did not fall, so keep the load and available-memory guards and use
the governor's observed capacity. Task-specific owner budgets still bind;
a source/default change does not authorize increasing live capacity.
Heavy and simulator leases have independent budgets; the default simulator limit is one. Load and available-memory guards gate both.
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

Acquire answers within about 20 seconds; `--wait SECONDS` keeps polling and
prints progress on stderr. Acquire is idempotent per seat, occupant and holder for a matching selection.
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
  you stop waiting. Acquire again (or `--wait`) to get it.
- `waiting`: every slot is held. `hint` and `blockers` name the seats holding
  leases, devices booted outside leases (and the seats whose processes use
  them). Heavy commands use their own budget. Wait, or ask the named holder to release.
- `rejected`: `reason` is the cause. `service_restarting`: retry shortly.
  `owner_unavailable`: your seat's live occupant could not be proven.
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

Touch the lease while actively using it; its default idle timeout is ten
minutes. Release when finished. Release, idle expiry or a verified seat exit
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
