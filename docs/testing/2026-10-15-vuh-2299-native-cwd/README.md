# VUH-2299: native cwd reads preserve the membership deadline

Tracks: https://linear.app/vuhlp/issue/VUH-2299

The owner-started cwd case failed on unchanged `35551ada4`: its membership
read crossed the five-second production deadline. Workspace collection and
publication each require two fresh cwd observations. Three measurements of the
old `lsof -a -p PID -d cwd -Fn` call took 2.397–2.519 seconds apiece; four calls
can consume roughly ten seconds before the other identity checks finish.

The existing native process helper now observes cwd directly from the kernel:
Darwin uses `PROC_PIDVNODEPATHINFO`; Linux uses the existing pinned procfs path.
Two cwd observations remain bracketed by agreeing live same-user process
identities, with the helper's existing bounded transport. The membership
collection/publication checks, canonical-path checks, cancellation, test
assertions and five-second deadline remain intact. No cwd result is cached.
Both the display membership adapter and tool workspace resolver share this path.

## Checks

- Unchanged baseline: the exact case failed at `Membership deadline`, 9.652s.
  Earlier root/isolated `unknown/timeout` failures are linked on VUH-2291.
- Native C helper compiled with the shipped `-Wall -Wextra -Werror` build.
  Three real PID-local native cwd queries took **2.180–2.780ms**, returning the
  same observed directory as lsof on the same owned process.
- **24/24** fresh Vitest runs of the original case passed: twelve alongside
  normal fleet work, then twelve with an additional governed four-worker CPU
  load bounded to sixty seconds. Per-case durations were **96–151ms**. The
  loaded series observed all four heavy slots occupied, host load1
  **7.58–9.20 / 18 cores**, and sampled CPU **49.5–76.4%**. These are real
  recorded conditions, not injected admission observations.
- **116/116** focused checks passed across six membership, resolver, HTTP,
  native-adapter and route files. The added real-process boundary case observes
  `chdir`, quotes/newline/Unicode paths, cancellation and an exited process.
- Explicit touched-file formatting and lint passed. Linux Python syntax parsed;
  the positive Linux kernel path was not exercised on this Mac.

[Combined source diff, commands, timing measurements and repeat-run captures](captures.txt)
contains the focused evidence. The exact-tree root landing result and SHA will
be posted on the issue. No eval or installed-service update/restart ran.
