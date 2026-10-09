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
service preserves capture behavior. The simulator was previously booted; a new
repeat-boot comparison and the two owned bounded rounds remain pending.

Before this boot, no simulator tree existed, `fseventsd` alone had about
19.2 GiB RSS, and host load was about 44. Swap already held 9.7 GB and the
compressor occupied about 27 GiB. Host load and memory are shared-machine
measurements; this observation does not attribute all pressure to the simulator.

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

## Open work

Two bounded boots of this same existing device wait behind the lead's app order:
vuh-1856b, vuh-1882, vuh-1875, vuh-1874. The CLI uses retry polling, not durable
FIFO simulator tickets, so this worker must respect that order before acquiring.
Passive sampling across their rounds provides additional repeat-boot evidence.

Release already shuts a device down immediately and retains it for reuse;
`simulatorIdleMs = 600000` is the abandoned-lease fallback. Whether to change that
fallback or keep a device warm between captures remains open. No simulator
service was disabled, and no live setting, fleet note or machine-wide daemon was
changed. A deployed capture with headroom remains required; source tests alone
do not prove that acceptance criterion.

Raw samples and checks stay in ignored `.local/vuh-1899/` in this worktree; bulk
JSON is not committed. Their manifest/store upload is pending the evidence-store
implementation (ADR 0258 is proposed). The initial `passive.jsonl` has no useful
simulator tree data and is excluded from conclusions. In the first corrected
sampler, the `cpuNs` field contains Mach ticks; later `rounds.jsonl` uses
`cpuTicks`. No CPU conclusion uses the mislabeled field without conversion.

Kernel references: [rusage implementation](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/bsd_kern.c),
[VM statistics ABI](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/mach/vm_statistics.h).
