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
Serialize multi-package compilers inside one permit. An optional `--seat LABEL`
before `--` identifies a holder in status; it grants no seat authority. Arguments
after `--`, including flags such as `--chat`, belong to the child. The wrapper
preserves its exit status and forwards interruption. Nested commands in the same
verified process group reuse its permit. Detached surviving children retain the
permit until the kernel proves they have exited.

`clankie fleet resources` and `clankie doctor --json` show capacity, actual holders,
queue and pressure. Status includes executable names and labels, never arguments
or credentials. A wait can mean a full pool, high load, low available memory or
unavailable native observations. Available memory counts reclaimable pages
(free, speculative and inactive on macOS; `MemAvailable` on Linux), not only
strictly free ones. A failed observation refuses new local hires;
it does not terminate existing agents. Python 3 and the shipped native helper
must be available. Repair an unavailable installation through the existing setup
route; do not select another registry to evade a wait.

The owner sets capacity through `clankie fleet set --heavy-slots auto|N` and
`--simulator-slots N`, or `/fleet resources`. Automatic capacity is the smaller
of one slot per eight cores and one per 24 GiB RAM, with a minimum of one.
Simulator leases consume that same pool; the default simulator limit is one.
The registry belongs to the OS account and is shared across worktrees. Worker
`HOME`, state-path or `HEAVY_SLOTS` overrides cannot increase capacity.

# Lease a simulator

Use the owner-authorized CLI and an existing proven local native seat. The host
observes the seat's occupant and kernel process identities; caller claims cannot
replace that proof. Follow any task-specific owner approval before acquiring.

```sh
clankie simulator acquire '{"seatId":"SEAT","deviceType":"com.apple.CoreSimulator.SimDeviceType.iPhone-17","runtime":"com.apple.CoreSimulator.SimRuntime.iOS-26-0"}'
clankie simulator status
clankie simulator touch '{"seatId":"SEAT","id":"LEASE_ID"}'
clankie simulator release '{"seatId":"SEAT","id":"LEASE_ID"}'
```

Use the exact returned device UUID for subsequent simulator commands. Touch the
lease while actively using it; its default idle timeout is ten minutes. Release
when finished. A verified seat exit or idle expiry initiates cleanup of the exact
device this lease created. Unowned booted devices count against admission, but
are never shut down or deleted. Never run global shutdown, erase, delete-all or
unavailable-device cleanup for fleet work.

A missing or uncertain create receipt remains held for operator review. Do not
retry native create or infer ownership from a device name. A stopped observer
preserves leases. Status and the original journal distinguish a held receipt
from successful cleanup.

Run resource stress checks only manually or in the release gate. Personal-repo
push and PR checks remain fast and scoped; evals remain explicit manual runs.
