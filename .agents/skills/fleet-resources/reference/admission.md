# Heavy admission

How the governor decides, for when a wait or a status reading needs explaining.
The daily rules are in [the skill](../SKILL.md).

## Capacity

`heavySlots` is a ceiling (automatic: one per two cores and per 12 GiB; for
example nine on an 18-core, 128 GiB machine). One job per four cores runs on the
load and memory guards, each job admitted in the last minute counting four cores
of load, as the
[alternating benchmark](../../../../docs/testing/2026-10-08-heavy-parallelism/README.md)
supports. Each job above that starts only while the measured machine (the busier
of load and kernel CPU, plus a full four-core share for every job admitted in
the last minute) stays under 70% of the cores, with memory to spare.

When no full job is held, a valid load-only refusal admits the FIFO head if
memory meets the owner floor and load stays below twice `maxLoadRatio`. At or
above that cap, true overload still waits. Between the normal guard and the cap
it runs at most one full job at a time, counting starting/running and cleanup
leases; light and server jobs use separate budgets and do not count. Unknown
observations and low memory still refuse. Simulator boot guards do not use this
exception.

The service judges admission for every waiter from one view of the machine, so
don't run `clankie heavy` itself under a shim that changes what Node reports
about the machine (cores, memory); put such shims on the child command. The
registry belongs to the OS account and is shared across worktrees. Worker
`HOME`, state-path or `HEAVY_SLOTS` overrides cannot increase capacity.

macOS available memory matches `memory_pressure -Q` through the kernel's
compressor-aware percentage; Linux uses `MemAvailable`. macOS pressure reads
share a one-second cache. Failed observations refuse new local hires without
terminating existing agents. A local hire is refused only when available memory
is below its floor or the observation fails; high load admits it, and its
receipt's `resourceNotice` says its heavy work and simulator leases will queue
until load drops. Python 3 and the shipped native helper must be available.

`clankie fleet resources --machine ID` selects a registered host, with its own
specs, capacity, holders and queue. `local` and `default` select this service's
machine; an unavailable remote host never reports the local machine's snapshot.
All surfaces use the same resource status and revision-guarded fleet settings API.

## Tool limits

Each full permit passes `VITEST_MAX_WORKERS=4` and `TURBO_CONCURRENCY=4` to its
children, including package scripts and nested commands, preserving lower
positive integer environment limits. Under `clankie heavy`, inherited
`VITEST_MAX_WORKERS` beats `--maxWorkers`. Turbo tasks must pass these variables
through strict environment filtering (this repo's `turbo.json` does). Light-lane
tool threads are capped at two, preserving a lower explicit cap.

Clankie's checkout `pnpm typecheck` serializes compiler tasks and uses the shared
heap budget in `scripts/typecheck.mjs`; `docs/typechecking.md` describes bounded
programs and the retained diagnostics under `.local/typechecks/`. A higher
`NODE_OPTIONS` does not raise the compiler budget.

## Server lane

The lane has up to two slots and shares 20% of machine cores (at most 64 cores),
divided equally between its slots. Tool-native parallelism is capped at two; a
native supervisor samples the owned process group's CPU every 100 ms and
pauses/resumes exact process births to pay back excess CPU. Brief bursts can
exceed this sampled budget. Failed CPU observations resume the owned group and
report degraded enforcement while the permit stays held; accounting restarts
from a fresh baseline when observation recovers. Status exposes
`serverLeases[].cpuLimitUnenforcedSinceMs`; doctor says "CPU limit not enforced"
for failures lasting at least one minute. A nested server reuses a server
permit; under a bounded parent it takes its own.

## Holders, leftovers and alerts

What a leftover sweep stopped (process names and signals, never arguments) is
recorded in `leftovers.jsonl`; a lease released for a dead runner, in
`reaped.jsonl`. Status shows a lease as `leftovers`, or `orphaned` if its runner
died. A lock-helper fault before the journal write committed nothing and is
retried on a fresh helper, so a queued job does not die from it. Brief
journal-lock contention waits internally and keeps the queue ticket.

`fleet resources`, doctor, the TUI and waiting commands show server holders and
queue separately. The owning lead hears a holder alert only after a governed
server or build/check permit has been held for 15 minutes, at most once per lease
across refreshes and service restarts. `holderAlerts` identifies its lane, seat,
holder, executable and start time without arguments. An eligible heavy lane head
still queued after 60 seconds on consecutive arbiter passes also alerts the lead,
naming its ticket, owner seat, holder and PID. Pressure or capacity waits stay
quiet. Read `clankie fleet resources` and coordinate with the named owner; the
observer never requeues work or edits the registry.

`clankie integrate` gates share one service-owned full permit, admitted in FIFO
order alongside ordinary builds; `mergeGate` in resource status identifies the
batch. Sharing requires the updated service arbiter and clients; do not bypass an
older installation's wait with another registry or launch route.

## Disk

Free disk is sampled on the working-directory and OS-account home volumes.
Doctor and the lead's fleet round warn below either 200 GiB or 10% free. All new
heavy jobs (full, light and server lanes) wait below 20 GiB free; existing jobs
keep running. An unavailable disk observation refuses admission. Set
`minFreeDiskGb`, `warnFreeDiskGb` and `warnFreeDiskPercent` through the fleet
settings API, `/fleet resources`, or
`clankie fleet set --minimum-free-disk-gb N --warn-free-disk-gb N --warn-free-disk-percent N`
(values are GiB despite the `-gb` spelling). These guards also apply to
simulator admission but do not stop existing leases or deny low-load social turns.

An unbounded `find`, `bfs` or recursive listing over all worktrees,
`node_modules` or `~/.clankie/integration` once held tens of thousands of open
descriptors and stalled every admission on the machine. Admission now tolerates
it, but such a scan still slows every worker's proof and the disk.

## Test fixtures

Service fixtures marked `VITEST=true` or `NODE_ENV=test` start with a private
temporary registry and native simulators disabled;
`CLANKIE_TEST_FLEET_RESOURCES_DIRECTORY` optionally retains the fixture journal
outside the live registry. The markers do not affect `clankie heavy` or worker
governors. Run resource stress checks only manually or in the release gate.

## Platform notes

The shared admission functions accept host-measured `ResourceHostSpecs` for a
later native runtime; these are not worker flags or a second registry. The
staged Linux PID-namespace helper is a containment primitive, not a second
capacity allocator or a WSL heavy-command route: native Windows and WSL share one
Windows host budget and canonical registry. Never acquire that Windows
`LockFileEx` lock through Linux `flock` on `/mnt/c`, and do not route WSL jobs
through the staged helper. Details:
[fleet-resources package](../../../../packages/fleet-resources/README.md).
