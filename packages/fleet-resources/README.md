# Fleet resources

The governor shares one OS-account registry in `~/.clankie/fleet-resources` across
Clankie worktrees and native worker environments. Owner-authenticated control
calls `configure`; command callers read that policy. `HOME`, `CLANKIE_STATE`,
settings-path overrides and `HEAVY_SLOTS` do not select a separate registry or
increase capacity. Directory and pressure-probe injection exist for isolated tests.

Heavy commands and simulator reservations consume the same permit pool. Automatic
capacity is the smaller of one permit per eight available cores and one per 24GiB
of RAM, with a minimum of one. The simulator limit defaults to one. FIFO tickets
are removed on cancellation or a proven requester exit. High pressure delays
resource admission and refuses new builders; unavailable native observations fail
closed. A zero simulator limit disables new simulator admission and rejects
already queued simulator tickets; valid requests retain global FIFO ordering.
Python 3 and the shipped native helper are required for OS locking and
process observations on macOS or Linux. Availability probes the helper
process itself, so a hosted captain running as PID 1 can perform pressure
admission without granting PID 1 lease or signal authority. The hosted Linux
image installs Python 3; self-hosted hosts must provide it.

The heavy runner registers its process birth under the journal's kernel file lock
before receiving execution permission. A dead claim owner cannot authorize a late
runner. A registered runner owns its process group independently of its wrapper;
surviving group members retain capacity after either process is killed. Native
read failures remain unknown. A failed broad census falls back to exact recorded
process proofs; kernel group existence still retains capacity. Runner settlement
counts all UIDs in its group, excluding its own bounded observer and proved
zombies, so privileged descendants also retain the permit. Nested
heavy commands reuse an inherited permit only when the caller belongs to the
registered group. Signals require the exact observed process birth. Journal and
status metadata contain the executable name and optional caller label, never
command arguments, environment, or bearer credentials. Public PIDs identify real
holders; caller seat labels do not confer ownership or cleanup authority.

Simulator reservations remain durable when request processes die. Only the
simulator manager can settle native receipts and release them after confirmed
shutdown/deletion of the exact device it created. `snapshot` does asynchronous
reconciliation; the runtime publishes a cached result to health and roster readers.

The subprocess integration suite exercises actual OS locks, processes, filesystem
receipts, cancellation and native runner registration. It never hires agents or
boots simulators. Run manually through the fleet heavy limiter; production native
device behavior requires a separately authorized simulator check.
