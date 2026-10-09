# fseventsd path investigation (VUH-1871)

[Issue](https://linear.app/vuhlp/issue/VUH-1871). This covers only the daemon
investigation, not the issue's separate resource-accounting implementation.

`fseventsd` PID 550 used 17.6 GiB RSS and about 19 GB physical footprint.
Interval `top` samples measured 101–106% CPU. Four new user-level FSEvents
streams each observed 20 seconds of current events (no historical replay), with
file events and 250 ms delivery latency. Roots were `~/dev`,
`~/Library/Developer`, `~/.clankie`, `~/Library/Caches` and `/private/var/folders`
to include Metro/cache/test temporary paths. The streams were stopped and
released after every window. No other processes or settings changed.

| Window (UTC, 2026-10-09) | Delivered events | Main activity                                          | Dropped flags                    |
| ------------------------ | ---------------- | ------------------------------------------------------ | -------------------------------- |
| 01:44:10–01:44:30        | 1,227            | 1,052 temporary; 52 app repo; 3 node_modules           | None                             |
| 01:45:04–01:45:24        | 75               | 46 temporary; 27 Clankie state                         | None                             |
| 01:46:12–01:46:32        | 2,135            | 1,822 this worktree; 122 historical-test worktree      | 10 UserDropped / MustScanSubDirs |
| 01:48:32–01:48:52        | 145              | 66 temporary; 70 Clankie state; 8 dev (1 node_modules) | None                             |

The third window is incomplete: dropped flags require a rescan and prevent
treating delivered counts as the full event stream. Worktree activity includes
our own tests and Git operations. Stream events can be coalesced; these counts
are delivered notifications, not syscall counts or daemon client requests.

During the fourth window, interval CPU remained 101.9–105.8% and the physical
footprint remained about 19 GB despite only 145 notifications and no loss flags.
No DerivedData, CoreSimulator-data or named Metro-cache events appeared in the
loss-free quiet windows. One Metro command was present (PID 95555, parent 1,
about four days old); its presence is not evidence it causes the daemon cost.
The private app's Metro configuration watches linked source and dependency
realpaths for resolution, so blindly excluding all `node_modules` could break it.

## What the evidence supports

The observed quiet window does not support watcher exclusions as a demonstrated
fix. A user stream shows paths producing notifications, not which subscriber
retains a backlog or where the daemon spends CPU. Backlog, subscriber behavior
and daemon-internal work remain unproven possibilities.

Clankie's production source uses one nonrecursive `fs.watch` on the Herdr
summary directory (`herdr-fleet-changes.ts`) and one `watchFile` stat poll on
the summary file (`herdr-watch.ts`). No recursive worktree or dependency watcher
was found. There is no evidenced Clankie watcher fix to land.

Unprivileged `sample` and `fs_usage` refused access. The lead is bringing these
exact bounded, read-only proposals to James; **neither was run**:

```sh
sudo /usr/bin/sample 550 2 1 -file /tmp/vuh-1871-fseventsd-sample.txt
sudo /usr/bin/fs_usage -w -f filesys -t 10 fseventsd > /tmp/vuh-1871-fseventsd-fs-usage.txt
```

Recheck that PID 550 is still `fseventsd` before any authorized capture. Its
filesystem trace may show only journal I/O; attributing event producers may then
require an owner-approved trace of all filesystem writers. Diagnose the sampled
stack before proposing watcher changes, restarting a daemon or changing
Spotlight. None of those actions is authorized or performed here.

[Aggregated observations](observations.json) retain the categories and interval
CPU samples. The [user-level stream script](stream.py) is the final window's
collector; raw logs remain in this worktree's `.local/` directory.
VUH-1871's root cause remains unproven.
