# VUH-2202: real worktree cache reclaim

The baseline reclaimed **0**. The fixed checkout CLI/API reclaimed **166 caches in 14 real clankie-app worktrees**, using the enrolled local roots and default six-hour retention. The first sweep reclaimed 36 and named all 57 deferred worktrees; exact-path continuations examined all of them. Enrollment changed during the final continuations: cleanup stopped, then eight interrupted paths were retried after a fresh enrollment read.

Available space (`df -k /Users/james/dev/clankie-app`) before the fixed sweep was **710,643,176 KiB (677.722 GiB)**; afterwards **717,102,456 KiB (683.882 GiB)**: **6.160 GiB net increase**. Other fleet work and native proof fixtures were active, so this is the observed filesystem delta, not an isolated allocation attribution. Raw df checkpoints are in the artifact.

All 89 observed worktree HEADs and Git status outputs stayed identical. Dirty trees, live cwds, and recent installs were retained. Source, commits, logs and `.local` evidence remained. The reclaimed vuh-1719 HEAD is an ancestor of cached app origin/main; the other two original affected trees retain their unlanded commits. The new importer proof uses the root pnpm install marker plus installed lockfile snapshot and canonical Git ownership. Unknown importers stay intact. Complete repository scans run before and after renaming with the existing depth, handle and time limits; large installs no longer fail solely on the number of entries. The low-disk warning change has its own commit.

Checks through `clankie heavy --`:

- Native offline pnpm workspace + Rust, real TCP owner API and CLI: passed (including dirty/live/recent and unknown-importer preservation).
- Explicit manual 100,005-file offline pnpm install: passed, including a nested repository, bounded Git output, rollback collision and 34 registered worktrees with exact continuation.
- Explicit touched-file formatting and lint: passed. The integrator supplies the root exact-tree landing gate.

Protected raw evidence: `clankie://evidence/sha256/79a093075fd3aa1ac1c9aff530c864979668a5c2fb0122213ad453503a821fca`. The bundle includes all real receipts, df checkpoints, HEAD/status comparisons, landed proof, native test results and source CLI proof programs. Deployment and issue closure belong to the lead.
