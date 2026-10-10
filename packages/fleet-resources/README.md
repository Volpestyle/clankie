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
heavy capacity is the smaller of one permit per four available cores and one per 24GiB
of RAM, with a minimum of one. Automatic simulator capacity is
`max(1, min(floor(cores/2/2), floor(RAM_GiB/2/34)))`: half the machine at the
measured cost of one simulator under test (see
[the simulator run](../../docs/testing/2026-10-09-lean-simulators/README.md)).
Owner settings may say `auto`; the service resolves it to that count before
configuring the shared registry, which always holds an exact integer every
installed CLI can read. A new simulator is refused with `pressure` for three minutes after the previous
admission, because a cold boot's burst outruns the one-minute load average.
Heavy
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
paths; an acquired transaction deadline reports its own cause. The helper writes
the journal only after reading its request, so a fault at any earlier stage
(through `request-read`) committed nothing: the store reruns that transaction on
a fresh helper, up to three attempts, instead of failing a queued job (VUH-2027).

On macOS, available memory is the smaller of the kernel's
`kern.memorystatus_level` percentage of RAM and free plus file-backed resident
pages (excluding speculative pages already counted as free). This bounds the
percentage by headroom that does not require more compression or swap of
anonymous pages. File-backed pages may still need disk I/O to reclaim; it is an
estimate, not a reservation. The Python native boundary reads `sysctlbyname`
and `HOST_VM_INFO64` directly, without launching `vm_stat` or `memory_pressure`. One shared
one-second cache and an in-flight read coalesce repeated sampler calls in each
process. An expired value never supplies a fallback when the native read fails;
invalid or unavailable observations refuse new work. This pressure cache grants
no process, lease or signaling authority. Linux retains `/proc/meminfo`'s
`MemAvailable`; other platforms retain their existing free-memory source.

The heavy runner registers its process birth under the journal's kernel file lock
before receiving execution permission. A dead claim owner cannot authorize a late
runner. A registered runner owns its process group independently of its wrapper;
surviving group members retain capacity after either process is killed, but only
briefly once the command is gone (VUH-2027). When the command exits with members
left in its group, status shows `leftovers`; after `LEFTOVER_GRACE_SECONDS` (10s)
the runner TERMs the group, KILLs survivors five seconds later, appends what it
stopped (names and signals, never arguments) to `leftovers.jsonl`, and frees the
slot. Status shows a lease whose runner is proven dead as `orphaned` while live
members remain; the governor gives it the same grace, then starts the native
`stop-leftovers` helper outside the lock. Group IDs are not reused while a
member lives, so the group stays that lease's signal authority. The grace marker
lives in `leftovers/<lease>.json` beside the journal, never in it.
Once a census proves no live member is left (zombies excluded), reconciliation
reaps the lease, admits the next queued job on its next tick, and appends a
receipt to `reaped.jsonl` beside the journal: reason (`runner_exited` or
`claim_owner_exited`), lease, seat, holder, executable and PID, never arguments.
The journal's own schema is unchanged, so older readers keep working. Native
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
`holderId`. New acquires/plans require that task holder; missing native hook
metadata refuses rather than returning a seat-level sibling lease. Legacy
holderless reservations retain their original touch/release identity. Simulator idempotency, in-flight deduplication, touch and release
include it; concurrent acquires serialize and validate each request’s selection
instead of sharing the first result. Existing leases refuse a different UDID,
exact model or runtime. Busy explicit UDIDs wait without selecting an idle
alternative. The CLI validates successful grants against holder and selection.
Heavy lease and queue metadata retain it. Older journal claims without
a holder stay root-owned. Claude Bash hooks carry session plus `agent_id` in
`CLANKIE_RESOURCE_HOLDER`; Codex CLI calls prefer the executing `CODEX_THREAD_ID` over inherited holder
labels. Claude scopes its holder to a command subshell and clears ancestor
Codex metadata, so a persistent shell cannot retain a sibling identity. Other harnesses
can pass explicit holder labels. The host still proves the original seat, occupant,
binding and live processes; a holder label grants no authority. A seat
observation that fails is unproven, not disproven: a waiting acquire keeps its
ticket through failed observations for `UNPROVEN_GRACE_MS` (two minutes), and an
admitted lease is kept for its next resume rather than forgotten. Only an
observed different occupant or exited process refuses at once (VUH-2055). Child leases
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
Planning grants no slot or authority; acquire rechecks both before effects. Simulator admission records a FIFO ticket in the same OS-locked journal. It
contains the proven native owner, task holder, original device/model/runtime and
exact flag, resolved existing device, creation time and five-minute stale deadline.
The manager blocks on that ticket; notifications wake local waits, with bounded
journal checks for pressure and other processes. A restart preserves live tickets.
An atomic grant consumes only the front ticket for its device and pins that device
in the reservation before preparation. A freed slot goes to the oldest ticket
waiting for a slot, whatever device it names: a holder that releases one device
and asks for another queues like anyone else (VUH-2008). An older ticket whose
device another lease holds waits for that device, so other device queues proceed;
the heavy FIFO is independent. `tryAcquireSimulator` remains the nonblocking atomic admission step;
external clients use one blocking CLI/API acquire, not repeated acquire requests.
The API accepts `waitMs` (0 for an immediate ticket receipt) and optional `ticketId`
for resuming. The CLI defaults to a one-hour wait and sends acquire only once.
The holder can cancel its own ticket; changing selection requires cancellation.
Active waiters renew expiry; dead process births and stale tickets are pruned,
while unknown process observations stay unknown. Queue position is per target;
the wait estimate uses remaining idle time and one idle budget per preceding
ticket, so renewals can extend it. Pressure/unknown occupancy can make it null.
Cancel a queued ticket on a client wait abort; an admitted boot remains owned by
the manager, so a caller that disconnects never strands a lease (ADR 0249). The native helper's
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

`simulator verify` is an authenticated read-only preflight for device users: it
checks the proven seat occupant, task holder, lease ID, exact UDID and booted
state. It neither adopts nor renews a lease. Install, launch and drive clients
should call it before acting. Clankie cannot intercept separately issued raw
simctl/Xcode/external MCP operations or lock across them; the preflight is not a
system-wide access control boundary. Worker plugin 0.6.11 versions the resource
hook changes; doctor and native setup verify the Bash resource hook as well as
lifecycle hooks, including named Claude profiles such as `.claude-james`.

Simulator runtime usage is exposed on each device lease in `fleet resources`
and `simulator status`, beside its `holderId`; unleased devices also expose
usage in simulator status. The read-only native census identifies each device's
`launchd_sim` bootstrap path and its descendants. `usage.footprintBytes` sums
kernel physical-footprint charges (including private compressed memory), while
`rssBytes` includes shared resident pages and must not be treated as additional
physical memory. CPU time uses the native Mach timebase; `cpuPercent` is an
interval observation with 100% equal to one core, not lifetime average CPU.
Processes that exit between samples can be missed, so interval CPU is a lower
bound. A partial read names its unavailable process count; failed or unmapped
observations are `unavailable`, never a zero charge. These diagnostic samples
have a five-second cache and grant no device/process authority. Admission uses
whole-machine load and available memory, which already include the simulator;
subtracting its footprint again would double-count it. The device ceiling and
explicit owner overrides still bind.
