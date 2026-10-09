# Simulator memory: VUH-1899

The existing iPhone 17 Pro on iOS 27 (`ECF31A58-614F-40A7-87C9-914A4930D974`)
reached about 59 GiB summed resident size but about 33 GiB summed kernel
physical-footprint charges during the app holder's 2026-10-09 04:53Z round.
Those are different measurements. RSS includes shared resident pages repeatedly;
footprint includes private compressed memory and is not the same as current
free-page consumption. The original approximately 50 GB RSS observation cannot
be described as 50 GB of additional physical RAM used.

## First observation

Read-only host samples every ten seconds observed holder `vuh-1856b` without
installing, launching, driving, touching or releasing its simulator. Moss's
quiet test window ended before this boot. No simulator was booted by this worker.
The first useful simulator-tree sample was about 48 seconds after boot: the
initial sampler assumed `comm` included a path, whereas `launchd_sim` was a
bare name. This was corrected; the first 48 seconds are not measured.

| UTC      | Processes | Summed RSS, GiB | Summed footprint, GiB | Host load, 1 min |
| -------- | --------: | --------------: | --------------------: | ---------------: |
| 04:53:46 |       176 |           50.82 |                 20.58 |           162.80 |
| 04:53:54 |       192 |           54.63 |                 22.68 |           165.61 |
| 04:54:44 |       237 |           62.14 |                 28.55 |           107.74 |
| 04:55:35 |       242 |           56.24 |                 30.05 |            76.71 |
| 04:58:18 |       264 |           57.36 |                 32.84 |            55.04 |
| 05:00:19 |       267 |           57.96 |                 32.88 |            19.11 |
| 05:04:57 |       267 |           58.85 |                 32.82 |            25.24 |

Early large footprint charges included SpringBoard, Campo, Spotlight,
PosterBoard, widget/poster extensions and Clankie; a later app process exceeded
1 GiB. This does not isolate a defective service or establish that disabling any
service preserves capture behavior. The simulator was previously booted. Later passive observations below cover
additional boots; the two owned bounded rounds remain pending.

Before this boot, no simulator tree existed, `fseventsd` alone had about
19.2 GiB RSS, and host load was about 44. Swap already held 9.7 GB and the
compressor occupied about 27 GiB. Host load and memory are shared-machine
measurements; this observation does not attribute all pressure to the simulator.

## Additional app rounds

The same device shut down between app holders and returned with a new
`launchd_sim` process identity each time. The read-only census continued;
this worker did not control the workloads or boot any device.

| Observed holder | Root PID | First observed UTC | Peak footprint, GiB | Peak footprint UTC | Last observed footprint, GiB |
| --------------- | -------: | ------------------ | ------------------: | ------------------ | ---------------------------: |
| vuh-1856b       |    64479 | 04:53:46           |               33.45 | 05:25:58           |            33.31 at 05:30:54 |
| vuh-1882        |    23430 | 05:31:14           |               33.59 | 05:34:25           |            32.89 at 05:56:41 |
| vuh-1875-iphone |    30192 | 05:59:15           |               40.59 | 06:04:41           |            33.23 at 06:13:02 |

The third round is still running at this cutoff. Its peak included 301 processes
and 74.89 GiB summed RSS. The second and third observed boots reached host
one-minute load peaks of 199.01 and 226.44 respectively. These are shared-host
loads, not isolated simulator CPU measurements. Process exits can make a census
partial, and ten-second sampling misses shorter peaks.

This supports a recurring substantial footprint rather than a cost confined to
a device's first-ever boot. It does not isolate boot overhead from app work or
prove every future boot has the same cost. The controlled repeat and deployed
capture acceptance remain open.

The policy supported so far is to keep a device booted only while its holder is
using it, then release and shut it down after the round. Retain the existing
ten-minute abandoned-lease timeout and heartbeat contract pending a controlled
comparison; it is not a promise to keep released devices warm. No particular
service has been shown both dispensable for captures and responsible for the
cost, so service trimming is not supported by these observations.

## Source change and checks

The read-only native census maps the exact device bootstrap path to its
`launchd_sim` tree and reads kernel `proc_pid_rusage` footprint, resident size
and CPU time. CPU uses `mach_timebase_info` (125/3 on this Mac); raw Mach ticks
must not be labeled nanoseconds. Native identity checks bracket usage reads.
Snapshots charge the device to its existing task holder, show unmanaged-device
usage separately, and report partial/unavailable reads instead of zero.
No diagnostic sample grants device, process, holder or release authority.

Darwin admission memory is bounded by free and file-backed pages as well as
`kern.memorystatus_level`. During this round, the old percentage reported about
79 GiB available while the bound was about 28 GiB. Anonymous/compressed pages
are not counted as immediately available; file-backed pages can still require
I/O to reclaim. Existing global load and memory guards already include the
simulator cost, so the per-holder footprint is not subtracted twice. Budgets,
idle timeout and owner overrides are unchanged.

Focused simulator accounting, Darwin memory, simulator lifecycle and service
resource-route/hire files passed 64/64 without skips. Fleet-resources, protocol,
service and TUI typechecks passed. The accounting test uses an owned native
process tree, actual kernel reads and the public API schema, without booting a
device. A follow-up native process-tree check passed with assertions proving the Mach
timebase conversion and nonzero interval CPU. Doc link and retired-claim checks
passed (578 Markdown files).

The initial source landing missed the full root gate: the new archive README
needed formatting, and `FleetSimulatorUsageSchema` was unnecessarily exported.
The lead corrected formatting in `37c664af1`; Ivy made the schema internal in
`ac0765248`. The duplicate local schema edit was discarded. The full root
`clankie heavy -- pnpm check:landing` then passed on clean `ac0765248`, including
formatting, lint, deadcode, docs and all 31 cached typecheck tasks. Its changed-test
step found no test files because the worktree matched `origin/main`; that result
does not replace the focused behavioral checks above.

## Open work

Two bounded boots of this same existing device wait behind the lead's app order:
vuh-1856b, vuh-1882, vuh-1875, vuh-1874. The CLI uses retry polling, not durable
FIFO simulator tickets, so this worker must respect that order before acquiring.
Passive sampling across their rounds provides additional repeat-boot evidence.

Release already shuts a device down immediately and retains it for reuse;
`simulatorIdleMs = 600000` is the abandoned-lease fallback. The controlled comparison of the
fallback and between-capture warming remains open; the passive evidence above
supports retaining immediate shutdown on release. No simulator
service was disabled, and no live setting, fleet note or machine-wide daemon was
changed. A deployed capture with headroom remains required; source tests alone
do not prove that acceptance criterion.

Raw samples and checks stay in ignored `.local/vuh-1899/` in this worktree; bulk
JSON is not committed. Their manifest/store upload is pending the evidence-store
implementation (ADR 0258 is proposed). The initial `passive.jsonl` has no useful
simulator tree data and is excluded from conclusions. The corrected
`passive-fixed.jsonl` and later `rounds.jsonl` retain CPU counters as `cpuTicks`
and require the Mach timebase conversion before computing CPU time.

Kernel references: [rusage implementation](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/bsd_kern.c),
[VM statistics ABI](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/mach/vm_statistics.h).
