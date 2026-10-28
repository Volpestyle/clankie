# Fleet resources

The staged Linux containment primitive for VUH-2091 lives in
`src/linux-namespace.py`. It is not wired into admission and does not allocate
capacity. Its private per-job receipt preserves the native birth of a namespace
init, and its command stays behind an execution gate until that receipt is
durable. Cancellation uses the pinned init's pidfd. Wrapper/setup crashes kill
init through race-checked parent-death signals; Linux then kills and drains its
PID namespace, including detached double-forks and nested namespaces. An
unavailable observation retains the receipt. A supervisor reply or recorded
`empty` flag alone cannot authorize release.

Private protocol: start `python3 -I -B src/linux-namespace.py run [DIRECTORY]`
with a pipe as stdin. Send one JSON line containing UUID `id`, UUID `permitId`,
64-hex `token`, `command` and string-array `args`. The helper emits `prepared`
with `namespaceInit` (native PID, UID, boot ID/start ticks, namespace inode and
PID-1 witness). A future host adapter must durably bind this proof to its
canonical budget permit before sending `{id, token, action:"go"}`. The helper
writes `running` before opening the gate. `{id, token, action:"cancel"}`, EOF or
interruption kills the contained tree. Command output goes to stderr; stdin is
`/dev/null`. Command exit retains `cleanup` for up to ten seconds while leftovers
live, then init exits to kill them. Final replies contain `empty`; only
`released, empty:true` is cleanup evidence. Unknown cleanup reports `held`.

`python3 -I -B src/linux-namespace.py inspect DIRECTORY ID` takes the same
exclusive per-job lock and re-observes the recorded birth; a live lock or
uncertain identity retains the receipt. Recovery never signals a reused PID.
The default receipt root comes from the OS-account profile, independent of
`HOME`. Receipts are private, atomically replaced and fsynced; the dedicated
lock releases on process death. No command arguments are persisted.

This slice refuses detected WSL. Windows interop containment, native/WSL
dispatch through one canonical Windows budget, setup and PC proofs remain
open. Linux `flock` on `/mnt/c` must never be used to acquire the Windows
`LockFileEx` budget lock. Existing Mac lanes and KH2's build lock are unchanged.
See the [local proof](../../docs/testing/2026-10-11-linux-containment/README.md)
for the container prerequisites and exact tested boundary.

Every heavy command inherits `VITEST_MAX_WORKERS=4` and `TURBO_CONCURRENCY=4`,
or a lower positive integer supplied by the caller. These tool-native limits
reach package scripts and verified nested permits. Turbo tasks must allow them
through strict environment filtering (`globalPassThroughEnv` in this repository).
Turbo CLI flags can override its environment: avoid higher `--concurrency` or
`--parallel`. Arbitrary tools and subprocesses need their own limits; this is
not an OS CPU quota.

`heavySlots` is a ceiling, not a fixed pool (VUH-2054). The base slots,
`min(heavySlots, max(1, min(floor(cores/4), floor(RAM_GiB/24))))`, give each job a full
four-worker budget and run on the load and memory guards. When no full lease is
held, a valid load-only refusal may admit the FIFO head if available memory
meets the owner floor and load stays below twice `maxLoadRatio`. At or above that
cap, real thrash still refuses. Between the normal guard and the cap, external
load then admits at most one full job at a time; starting, running and cleanup
full leases all count as held. Light and server jobs have separate budgets and
do not count. Unknown observations and low memory still refuse. Simulator boot
guards are unchanged.
Ordinary admission counts a full four-core
share charged against the load guard for every job admitted in the last minute,
which load1 cannot see yet (at load 1.48, four waiters once started within a
second); the
[alternating benchmark](../../docs/testing/2026-10-08-heavy-parallelism/README.md)
supports four capped jobs for throughput on the 18-core, 128 GiB Mac. Above the
base, the next queued job starts only while the measured machine stays under 70%
of its cores, with 8 GiB per unsettled job above the memory floor. "Measured" is
the busier of the load average and the kernel's per-core CPU ticks, plus a full
four-core share for every job admitted in the last minute, which neither
reading has seen ramp up yet. A summed per-process `ps` census is not used:
it misses short-lived compilers and test workers, and on 2026-10-10 read 6–10
busy cores while the kernel counted 13–14. Automatic `heavySlots` is
`max(1, min(floor(cores/2), floor(RAM_GiB/12)))`: nine on the 18-core, 128 GiB Mac.

Local merge-queue batches hold one service-owned full permit across installs
and landing gates, sharing the full lane's FIFO queue and slots with ordinary
builds. A gate neither jumps earlier builds nor holds spare slots; light jobs,
server jobs and simulator work use their normal independent admission rules.
All pressure, memory and capacity guards still apply. `mergeGate` in resource
status identifies a queued or running batch for observation, not an exclusive
reservation. Long-held gates appear in `holderAlerts` after fifteen minutes.
Token-bound `merge-gates/` sidecars leave version-1 journals readable; sharing
requires the updated service arbiter and clients.

Admission is judged once, by the service (VUH-2080). Its runtime calls
`arbitrate()` every second: under its one pressure sample it grants queue heads
in FIFO order, carrying each waiter's own identity and token, and refreshes
`arbiter.json`. While that heartbeat is under five seconds old, waiters only
watch for their grant, so a waiter that misreads the machine (on 2026-10-10 a
shimmed process counted 3 of 18 cores and held the queue for 20 minutes) cannot
hold the FIFO, and one that misreads it as calm cannot jump it. A waiter marks
its ticket in `grants/` before queueing; an unmarked ticket, from a client older
than this, is never granted and judges for itself. Without a fresh heartbeat,
or when the arbiter's own probe is unavailable, every waiter judges for itself
as before. A grant its waiter never took up is returned with the ticket, and
one whose waiter died is reaped like any starting lease.

Native observations go through one long-lived helper per process (VUH-2082):
`native.py serve` answers identity, observe, group, memory, snapshot and
availability requests, one JSON line each, and each registry journal has one
`native.py lock-serve` that runs its transactions in turn. Both run in their
own process group, never keep an idle process alive, and exit when their
parent closes the pipe. A timeout or fault ends that helper; pending requests
read as unknown and the next one starts afresh. A FIFO test case went from
about 110-210 Python starts to four or five. The heavy runner and rare reads
(simulator usage and referents, leftovers, harness census) stay one-shot.

The governor shares one OS-account registry in `~/.clankie/fleet-resources` across
Clankie worktrees and native worker environments. Owner-authenticated control
calls `configure`; command callers read that policy. `HOME`, `CLANKIE_STATE`,
settings-path overrides and `HEAVY_SLOTS` do not select a separate registry or
increase capacity. Directory and pressure-probe injection exist for isolated tests.

Service fixtures marked `VITEST=true` or `NODE_ENV=test` use a private temporary
registry by default and cannot access native simulators. The service-only
`CLANKIE_TEST_FLEET_RESOURCES_DIRECTORY` override selects a retained fixture
registry, outside the live registry (including symlink aliases and parent directories).
Vitest setup, allowlisted service journeys, the seat eval harness and release
smoke harness select this isolation. Unmarked services ignore the override.
The governor and `clankie heavy` never honor either test marker or the override;
fixture workers still consume the shared machine budget.

Heavy commands count only against `heavySlots`; simulator reservations and
unmanaged active devices count only against `simulatorSlots`. Status reports
`capacity.used` for heavy leases and `capacity.simulatorUsed` for simulator
reservations; simulator status separately counts external active devices. Automatic simulator capacity is
`max(1, min(floor(cores/2/2), floor(RAM_GiB/2/34)))`: half the machine at the
measured cost of one simulator under test (see
[the simulator run](../../docs/testing/2026-10-09-lean-simulators/README.md)).
Owner settings may say `auto`; the service resolves it to that count before
configuring the shared registry, which always holds an exact integer every
installed CLI can read. A new simulator is refused with `pressure` for three minutes after the previous
admission, because a cold boot's burst outruns the one-minute load average.
Heavy
commands wait in a FIFO queue; tickets are removed on cancellation or a proven
requester exit. A waiting command reads the journal without the lock and
locks only when it is the head with a free slot, or on a jittered full pass
about every five seconds that reconciles dead holders. Process and group
censuses and pressure samples run before a transaction, never while the OS
lock is held; an exit is permanent for an exact PID and start time, so a fact
read just before the lock can only retain a lease longer (VUH-2053). A queue
of waiters therefore no longer starves the service's own transactions. Simulator requests never queue: they take a free slot when they
ask or are told what holds the slots. High pressure delays heavy admission
and refuses simulator admission with that reason. Hire admission
(`admitBuilder`) refuses only below the memory floor; unavailable native
observations fail closed.

`runHeavy` sizes each command with `heavyJobLane`. Focused checks (Vitest
naming up to eight test files, `tsc` without `--build`, one package's
`pnpm --filter … typecheck`, or Oxfmt/Oxlint naming up to 64 existing files) take the light lane: a second journal in
`light/` with the same schema and native runner, so installs that predate it
never read it. Its capacity is the base heavy slots (one per four cores), its jobs are capped at two
cores, and only the memory floor (not load) holds it, because the full gates
it runs beside already answer to load. Status adds `capacity.lightSlots`,
`capacity.lightUsed`, `lightLeases` and `lightQueue`.
Explicit formatter/linter files work directly, through `pnpm exec`, and through
the repository's file-aware `fmt`, `fmt:check` and `lint` scripts. Their native
`--threads` budget matches the permit (two in light), keeping a lower explicit
cap. Directories, globs, missing files, unknown flags, type-aware linting and
whole-repository scripts remain full jobs. The root scripts retain their native
Vox checks only for whole-repository invocations. A zero simulator limit refuses
simulator admission without disturbing the heavy queue.
Python 3 and the shipped native helper are required for OS locking and
process observations on macOS or Linux. Availability probes the helper
process itself, so a hosted captain running as PID 1 can perform pressure
admission without granting PID 1 lease or signal authority. The hosted Linux
image installs Python 3; self-hosted hosts must provide it.

Long-lived dev servers have an independent `server/` journal, queue and up to
two slots. `heavyJobLane` recognizes Expo start, `pnpm dev`, Vite/Next dev and
watch commands; custom/opaque services opt in with `heavy --server`. Aggregate
server CPU is 20% of available cores (at most 64), split equally between slots,
and tool-native fan-out is two. `server-cpu.py`, loaded by the registered native
runner, samples group CPU without forking every 100 ms, charges reaped child
time, and pauses/resumes exact PID births to pay back excess usage. Short bursts
can exceed the sampled budget; reaped children already sampled can conservatively
be charged twice. CPU sample accounting is atomic across member reads. Darwin
zombies are skipped only after a kernel status query proves they have exited;
libproc alone cannot observe their identity. Unknown observations resume the
owned group and report degraded enforcement while its server permit stays held.
CPU may exceed its share during that failure; recovery starts from a fresh
baseline, without charging historical CPU or invented machine-wide debt.
During degradation, `serverLeases[].cpuLimitUnenforcedSinceMs` exposes the start
time through resource status and doctor displays "CPU limit not enforced". The
supervisor warns after one minute, then every five minutes, while retaining the
permit and restoring progress. Its atomic sidecar is bound to the exact runner
birth and supplies display metadata only, never admission or signal authority.
Verified nested servers reuse a server parent's permit; bounded parents give
servers their own separately governed permit. It governs same-user children remaining in the owned group,
not detached or privileged processes. The lane answers to the existing load and
memory guard but never occupies full/light slots. Native registration, signals,
exit status and leftover cleanup are shared with the existing runner.
Arbiter heartbeats advertise lane support: a new server waiter falls back to
its own admission while an installed older service handles only full/light.

Status adds server capacity, holders, queue and per-holder CPU budgets through
the API, CLI and TUI. `holderAlerts` names servers immediately and full/light jobs
after 15 minutes, without arguments. The service routes them through the native seat's
existing lead alert channel only after 15 minutes, once per lease across refreshes
and service restarts. An exclusive claim in the canonical OS-account registry's
`holder-notices/` directory precedes delivery. Definite undelivered notices retry;
uncertain delivery or a crash retains the claim, so a notice may be missed but
cannot repeat. Server metadata stays visible immediately in status.
Unknown labels do not select a conversation. Duration is diagnostic: no bounded
job is killed automatically because it ran too long.

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
`CLANKIE_RESOURCE_HOLDER` alongside `CLAUDE_SESSION_ID` and `CLAUDE_AGENT_ID`.
Automatic CLI labels derive from the executing `CODEX_THREAD_ID` or those
per-invocation Claude fields; an inherited holder alone is ignored. Claude scopes
these fields to a command subshell and clears ancestor Codex metadata, so a
persistent shell cannot retain a sibling identity. Hire allocation overrides all
four fields with empty values before creating a shell or prepared command pane,
including when the Herdr server inherited an operator's environment. Allocation
also clears `CLANKIE_SEAT_HARNESS`, `CLANKIE_SEAT_SESSION_ID` and
`CLANKIE_SEAT_PARENT_ARGV`; Herdr startup drops these ancestor seat markers too. Dedicated
Codex app-servers execute tools outside that pane: their launch also resets these
fields after merging the selected environment. This prevents the service's own
operator identity from leaking through its detached native server process. Other harnesses
can pass explicit holder labels. The host still proves the original seat, occupant,
binding and live processes; a holder label grants no authority. Simulator requests
accept an exact terminal ID or pane ID (qualified for a named local fleet), and
canonicalize it to the terminal ID after proof. Codex native proof does not depend
on the Claude-only `messageReceiver` field. A seat
observation that fails is unproven, not disproven: a waiting acquire keeps its
ticket through failed observations for `UNPROVEN_GRACE_MS` (two minutes), and an
admitted lease is kept for its next resume rather than forgotten. Only an
observed different occupant or exited process refuses at once (VUH-2055). Child leases
retain the root’s process proof and idle timeout, so a parent exit cleans them up.

Idle expiry uses freshly verified exact-holder native activity or a matching
queued/held heavy request whose recorded process descends from that native owner.
The task label alone cannot renew time. Native prompt idle starts the timeout;
repeated idle observations do not extend it. Unknown evidence expires from the
last proven activity. Explicit touch remains independent, as do reservation and
runaway cleanup. The manager does not persist activity as authority across its
restart. Supported native turn coverage and the open Claude root discriminator
are documented in the [simulator reference](../../.agents/skills/fleet-resources/reference/simulators.md).

Simulator reservations remain durable when request processes die. Only the
simulator manager can settle native receipts and release them after confirmed
shutdown of the exact device. It appends each settlement's reason to
`simulator-settled.jsonl` beside the journal (VUH-2353). The reasons are
`released`, `idle`, `owner_exited`, `reservation_stale`, `acquire_aborted`,
`device_missing` and `runaway`. `runaway` ends a booted lease early only after
its boot window (`simulatorBootSettleMs`) has passed and all of these have held
for two minutes: its census showed at least four cores, nobody touched it, and
the host was refused for load or memory. Any break restarts the window. Both
measured iOS 27 boot bursts, including the second poster render about 150
seconds in, stay inside the boot window
([measurements](../../docs/testing/2026-10-19-simulator-runaway/README.md)). Every device is kept for later reuse, including
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

Admission is checked once, when a job starts, and the journal holds only the
present. So that a load spike can be explained afterwards, the registry keeps
three histories beside it (VUH-2933). Each rotates to a single `.1` file, and
writing one never fails the work it describes:

- `leases.jsonl`: every heavy permit's `admitted` and `released` events from the
  command that holds it. Each carries its lane, holder, seat, command line
  (truncated to 256 characters), wait or hold time, exit code and load1. The
  command line shows `KEY=VALUE` values and the values of `-H` and
  token/key/secret/password/auth/header/cookie flags as `***`.
- `samples.jsonl`: every 30 s from the service: load 1/5/15, the share of all
  cores busy since the previous sample, free disk, and the five busiest
  processes.
- `bulk-ops.jsonl`: one line per service prune or cache reclaim, with its start,
  duration, outcome and counts. This work runs outside heavy admission.
  Integration reclaim writes the same line to its own directory.

The subprocess integration suite exercises actual OS locks, processes, filesystem
receipts, cancellation and native runner registration. It never hires agents or
boots simulators. Run manually through the fleet heavy limiter; production native
device behavior requires a separately authorized simulator check.

### Fast Linux fixture check

Push/PR CI runs `pnpm check:fleet-test-pressure`: a fixture-policy scan, seven
filesystem-based regression checks, and two real-process full-lane refusal cases.
The scan covers this package's tests, `.mjs` drivers and inline child scripts.
Every governor must have an explicit pressure probe in inline or locally declared
options. Ambient memory/load readers are refused outside the named native-observer
cases; the probe's local dependencies are inspected too. Opaque options are
refused rather than assumed controlled. This is a fixture convention, not a
general JavaScript dataflow or security analyzer.

The negative controls remove the real full-progress fixture's probe, introduce
aliased `freemem`/`loadavg` reads, and regress standalone/inline subprocess drivers.
Real native runners then prove low memory and load at the thrash cap retain one
queued ticket, zero permits and no started child, using explicit observations.
The disk-admission fixture controls unrelated memory/load while retaining real
filesystem samples. Production limits and existing assertions are unchanged.

Measured on Linux arm64 with two CPUs and a 4 GiB container limit, the exact script
body took 2.71–2.79 seconds across three samples (9 passing checks; two longer progress cases omitted by the
fast selector). This is local Linux evidence, not a GitHub-runner measurement.
It does not verify Linux `MemAvailable`, Darwin native memory, or release timing
under load. `darwin-pressure.integration.test.ts`, the native sampler/helper
observer cases, the full real-process progress/cleanup tests and release load
checks remain in manual macOS verification.

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

## Machine-scoped control

The service adds `fleet-resources?machine=ID` without changing the unselected
local snapshot. Owner `fleet.machineResources` entries are independent policies;
only local falls back to the legacy `fleet.resources`. Unknown IDs are refused,
and offline hosts expose their desired policy without a fabricated snapshot.
The remote host adapter must supply its canonical machine ID, measured specs and
its own governor snapshot. Status/configure calls are bounded to five seconds; a
wrong-host response is unavailable. The shared node-free protocol sizing function
uses those specs, not the observing Mac's hardware. Windows provisioning and
native/WSL admission belong to VUH-2091.

The package exports `ResourceHostSpecs` (`cores`, `memoryBytes`) and the shared
heavy policy functions `automaticHeavySlots`, `resourceCapacity`,
`baseHeavySlots` and `heavyAdmission`. A separate host runtime passes its own
validated native observations to these functions; omitted specs retain local OS
sizing. Admission uses the same host facts for the ceiling, base and unsettled
core charge. Invalid facts throw rather than falling back to the observing Mac.
These are runtime inputs, never client flags or registry-selection authority.
The existing POSIX governor continues to observe its local hardware. This seam
alone supplies neither a Windows runtime nor native/WSL containment.

Free disk is sampled on the working-directory and OS-account home volumes.
Doctor and the lead's fleet round warn below either 200 GiB or 10% free.
All new heavy jobs (full, light and server lanes) wait below 20 GiB free;
existing jobs keep running. An unavailable disk observation refuses admission.
Set `minFreeDiskGb`, `warnFreeDiskGb` and `warnFreeDiskPercent` through the
revision-guarded fleet settings API, `/fleet resources`, or
`clankie fleet set --minimum-free-disk-gb N --warn-free-disk-gb N --warn-free-disk-percent N`.
Values are in GiB despite the CLI's `-gb` spelling. These guards also apply to
simulator admission, but do not stop existing leases or deny low-load social turns.
