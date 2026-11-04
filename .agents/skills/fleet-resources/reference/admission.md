# Heavy admission

How the governor decides, for when a wait or a status reading needs explaining.
The daily rules are in [the skill](../SKILL.md).

## Capacity

Each lane is a FIFO slot queue (#599): a job starts when it is at the head and
a slot is free, and nothing else admits, delays or refuses it. No load, memory
or disk reading is consulted. Automatic `heavySlots` is one per four cores and
per 24 GiB (four on an 18-core, 128 GiB machine), each job holding a full
four-worker share; an owner value replaces it. The light lane is the same queue
with the worst-case count, capped by `heavySlots`. Before #599 a pressure gate sat
on top of the slots and held queues behind load that unmanaged processes caused.

The registry belongs to the OS account and is shared across worktrees. Worker
`HOME`, state-path or `HEAVY_SLOTS` overrides cannot increase capacity. A local
hire is refused only when the native host authority is unavailable (Python 3 and
the shipped native helper must be present); existing agents are never stopped.
`node scripts/heavy-waits.mjs` in a checkout prints median and p95 waits per
lane from `leases.jsonl` for a window.

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
tool threads are capped at two, preserving a lower explicit cap
([ADR 0179](../../../../docs/adr/0179-tests-run-in-forked-processes.md)).

Clankie's checkout `pnpm typecheck` serializes compiler tasks and uses the shared
heap budget in `scripts/typecheck.mjs`; `docs/typechecking.md` describes bounded
programs and the retained diagnostics under `.local/typechecks/`. A higher
`NODE_OPTIONS` does not raise the compiler budget.

## Server lane

Latency and event-loop measurements must use a bounded full-lane command, not `--server`: CPU repayment suspends the process (`SSTOP`) and appears as product stalls.

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
holder, executable and start time without arguments. Capacity waits stay
quiet. Read `clankie fleet resources` and coordinate with the named owner; the
observer never requeues work or edits the registry.

## Disk

Free disk is read on the registry volume. Doctor, status and the lead's fleet
round warn below either 200 GiB or 10% free; set `warnFreeDiskGb` and
`warnFreeDiskPercent` through the fleet settings API, `/fleet resources`, or
`clankie fleet set --warn-free-disk-gb N --warn-free-disk-percent N` (values are
GiB). The warning is informational: no lane or simulator waits on disk. The
retired `--minimum-free-disk-gb`, `--max-load-ratio` and
`--minimum-free-memory-mb` flags are refused, and the fleet settings API
answers `retired_setting` to a write that changes those fields.

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

## Another account's builds

A CI runner that runs as a different user cannot use `clankie heavy`: its
registry would be its own. The owner can let that one account queue through
`clankie fleet permits on --user USER`; its workflows then wrap heavy steps in
`node scripts/ci-heavy.mjs --`. Workers never turn this on and never change a
runner account; it is the owner's switch
([CLI reference](../../../../docs/cli.md)).

## Platform notes

The shared sizing functions accept host-measured `ResourceHostSpecs` for a
later native runtime; these are not worker flags or a second registry. The
staged Linux PID-namespace helper is a containment primitive, not a second
capacity allocator or a WSL heavy-command route: native Windows and WSL share one
Windows host budget and canonical registry. Never acquire that Windows
`LockFileEx` lock through Linux `flock` on `/mnt/c`, and do not route WSL jobs
through the staged helper. Details:
[fleet-resources package](../../../../packages/fleet-resources/README.md).
