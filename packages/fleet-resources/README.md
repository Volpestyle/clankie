# Fleet resources

The governor shares one OS-account registry in `~/.clankie/fleet-resources` across
Clankie worktrees and native worker environments. Owner-authenticated control
calls `configure`; command callers read that policy. `HOME`, `CLANKIE_STATE`,
settings-path overrides and `HEAVY_SLOTS` do not select a separate registry or
increase capacity. Directory and pressure-probe injection exist for isolated tests.

Heavy commands and simulator reservations consume the same permit pool. Automatic
capacity is the smaller of one permit per eight available cores and one per 24GiB
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
registered group. Signals require the exact observed process birth. Journal and
status metadata contain the executable name and optional caller label, never
command arguments, environment, or bearer credentials. Public PIDs identify real
holders; caller seat labels do not confer ownership or cleanup authority.

Simulator reservations remain durable when request processes die. Only the
simulator manager can settle native receipts and release them after confirmed
shutdown of the exact device, deleting it only when the lease created it
(`Clankie-<uuid>` journal name); a leased existing device is kept. Simulator
admission never waits: `tryAcquireSimulator` admits or returns the snapshot of
what holds the slots, and the manager owns create and boot after admission, so
a caller that disconnects never strands a lease (ADR 0249). The native helper's
`simulator-referents` mode reports which of this user's processes name a device
(PID, parent and executable only) so status can attribute external devices to
seats. `snapshot` does asynchronous reconciliation; the runtime publishes a
cached result to health and roster readers.

The subprocess integration suite exercises actual OS locks, processes, filesystem
receipts, cancellation and native runner registration. It never hires agents or
boots simulators. Run manually through the fleet heavy limiter; production native
device behavior requires a separately authorized simulator check.
