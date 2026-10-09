# Fleet resources

Every heavy command inherits `VITEST_MAX_WORKERS=4` and `TURBO_CONCURRENCY=4`,
or a lower positive integer supplied by the caller. These tool-native limits
reach package scripts and verified nested permits. Turbo tasks must allow them
through strict environment filtering (`globalPassThroughEnv` in this repository).
Turbo CLI flags can override its environment: avoid higher `--concurrency` or
`--parallel`. Arbitrary tools and subprocesses need their own limits; this is
not an OS CPU quota.

Automatic capacity is `max(1, min(floor(cores/4), floor(RAM_GiB/24)))`, allocating
one four-worker budget per slot. The [alternating benchmark](../../docs/testing/2026-10-08-heavy-parallelism/README.md)
supports four capped jobs for throughput on the 18-core, 128 GiB Mac, while
preserving pressure guards and explicit owner capacity overrides.

The governor shares one OS-account registry in `~/.clankie/fleet-resources` across
Clankie worktrees and native worker environments. Owner-authenticated control
calls `configure`; command callers read that policy. `HOME`, `CLANKIE_STATE`,
settings-path overrides and `HEAVY_SLOTS` do not select a separate registry or
increase capacity. Directory and pressure-probe injection exist for isolated tests.

Heavy commands count only against `heavySlots`; simulator reservations and
unmanaged active devices count only against `simulatorSlots`. Status reports
`capacity.used` for heavy leases and `capacity.simulatorUsed` for simulator
reservations; simulator status separately counts external active devices. Automatic
heavy capacity is the smaller of one permit per eight available cores and one per 24GiB
of RAM, with a minimum of one. The simulator limit defaults to one. Heavy
commands wait in a FIFO queue; tickets are removed on cancellation or a proven
requester exit. Simulator requests never queue: they take a free slot when they
ask or are told what holds the slots. High pressure delays heavy admission,
refuses simulator admission with that reason and refuses new builders;
unavailable native observations fail closed. A zero simulator limit refuses
simulator admission without disturbing the heavy queue.
Python 3 and the shipped native helper are required for OS locking and
process observations on macOS or Linux. Availability probes the helper
process itself, so a hosted captain running as PID 1 can perform pressure
admission without granting PID 1 lease or signal authority. The hosted Linux
image installs Python 3; self-hosted hosts must provide it.

Registry transactions wait for the kernel file lock without a contention timeout.
The 15-second transaction watchdog begins after acquisition, not while another
request holds the lock. Queued heavy requests retain their original tickets
through that wait. Cancellation terminates only the caller's waiting helper;
queue cleanup still commits under the same lock. Native lock failures report the
helper exit or signal and exception type/errno, without journal contents or
paths; an acquired transaction deadline reports its own cause.

On macOS, available memory is physical RAM multiplied by the kernel's
`kern.memorystatus_level` percentage, matching `memory_pressure -Q` rather than
summing selected VM page queues. The existing Python native boundary reads it
with `sysctlbyname`, without launching `vm_stat` or `memory_pressure`. One shared
one-second cache and an in-flight read coalesce repeated sampler calls in each
process. An expired value never supplies a fallback when the native read fails;
invalid or unavailable observations refuse new work. This pressure cache grants
no process, lease or signaling authority. Linux retains `/proc/meminfo`'s
`MemAvailable`; other platforms retain their existing free-memory source.

The heavy runner registers its process birth under the journal's kernel file lock
before receiving execution permission. A dead claim owner cannot authorize a late
runner. A registered runner owns its process group independently of its wrapper;
surviving group members retain capacity after either process is killed. Native
read failures remain unknown. Reconciliation batches only the current journal
owner and runner PIDs under the OS lock; it never treats a missing census row as
exit or reuses a cached observation as admission authority. Unrelated protected
processes cannot force serial per-owner helper forks. Kernel group existence
still retains capacity. Runner settlement counts all UIDs in its group,
excluding its own bounded observer and proved
zombies, so privileged descendants also retain the permit. Nested
heavy commands reuse an inherited permit only when the caller belongs to the
registered group and its supplied holder matches the permit. A different native
child takes its own permit even within that group. Signals require the exact observed process birth. Journal and
status metadata contain the executable name and optional caller label, never
command arguments, environment, or bearer credentials. Public PIDs identify real
holders; caller seat labels do not confer ownership or cleanup authority.

Native children share a seat and root occupant, but each has an optional stable
`holderId`. Simulator idempotency, in-flight deduplication, touch and release
include it; heavy lease and queue metadata retain it. Older journal claims without
a holder stay root-owned. Claude Bash hooks carry session plus `agent_id` in
`CLANKIE_RESOURCE_HOLDER`; Codex CLI calls use `CODEX_THREAD_ID`. Other harnesses
can pass explicit holder labels. The host still proves the original seat, occupant,
binding and live processes; a holder label grants no authority. Child leases
retain the root’s process proof and idle timeout, so a parent exit cleans them up.

Simulator reservations remain durable when request processes die. Only the
simulator manager can settle native receipts and release them after confirmed
shutdown of the exact device. Every device is kept for later reuse, including
ones created by Clankie; deletion requires an explicit owner tidy by exact
stopped UDID. A historical `Clankie-<uuid>` name grants no ownership. Active
journal claims (including a name with an uncertain create receipt) exclude
reuse. Selection prefers exact type, close model, then any idle iPhone or iPad
of the same family and runtime unless `exact` is requested. A read-only plan
lets the CLI announce creation and its expensive first boot before acquire.
Planning grants no slot or authority; acquire rechecks both before effects. Simulator
admission never waits: `tryAcquireSimulator` admits or returns the snapshot of
what holds the slots, and the manager owns create and boot after admission, so
a caller that disconnects never strands a lease (ADR 0249). The native helper's
`simulator-referents` mode reports which of this user's processes name a device
(PID, parent and executable only) so status can attribute external devices to
seats. `snapshot` does asynchronous reconciliation; the runtime publishes a
cached result to health and roster readers.

Within the requested family and runtime, a valid native `lastUsedAt` timestamp
puts previously booted devices ahead of devices with unknown boot history,
even when the latter match the requested model exactly. Among those candidates,
exact model then close model then family determines preference. `exact: true`
never substitutes a different model; an explicit `deviceId` remains strict.
Missing or malformed metadata is unknown, never proof of a previous boot.

The subprocess integration suite exercises actual OS locks, processes, filesystem
receipts, cancellation and native runner registration. It never hires agents or
boots simulators. Run manually through the fleet heavy limiter; production native
device behavior requires a separately authorized simulator check.
