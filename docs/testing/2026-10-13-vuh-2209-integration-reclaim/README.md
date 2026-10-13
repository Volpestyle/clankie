# VUH-2209: integration scratch reclamation

Tracks: https://linear.app/vuhlp/issue/VUH-2209

The checkout's CLI and real integration API handler reclaimed this Mac's real
`/Users/james/.clankie/integration` backlog through `clankie heavy`. No service
restart or deployment was performed. Queue-lock refusals deleted nothing;
sweeps held that lock and deferred to the running merge queue between passes.

## Result

Removed **17 worktrees and 247 private isolation/cache directories**:
**538.544 GiB of allocated blocks**. `df -k /Users/james` available space went
from **155.551 GiB** (163106884 KiB) to **688.152 GiB** (721580040 KiB):
**532.602 GiB net recovered** across the work. Shared blocks and concurrent
machine activity make allocated-byte sums differ from filesystem net recovery.

The first pass removed 13 trees (17.837 GiB allocated, 16.348 GiB net).
The lead then authorized private `isolation/` cleanup: one finished batch's
install/gate caches alone occupied 1.402 GiB. The large sweep removed 240
cache directories (497.433 GiB allocated). After the queued landings drained,
the final pass removed seven remaining/new cache directories and four trees
(23.274 GiB allocated); it reported no retained errors. No old terminal cache
directories remain. Passed/held and active batches remain protected.

Records, logs and commit stores remain. The final pass preserved **941 log
hashes, 177 nonterminal record hashes and the external worktree registry**.
The large sweep's final blanket registry-equality assertion failed during
concurrent fleet activity after its log/record hash checks passed; it compared
peer HEADs and new registrations too. Its 240 exact removals and byte counts
were recovered from durable `isolationReclamation` records. The later verifier
checkpointed CLI results and df before assertions; its registry check passed.
The large sweep's own second-stage df checkpoint was not saved before the
assertion, so its exact net delta is not claimed separately.

## Checks

Four acceptance checks passed with real Git repositories, bare origins, pnpm
installs and gate processes: ten consecutive landings leave neither worktrees
nor isolation caches; historical reclaim covers more than 32 trees, including
an interrupted removal missing `.git`; active/foreign/live process boundaries
stay protected; failed gates clean up automatically. Restore from retained
commit stores still works. An additional live-process check passed with a cwd
whose batch-relative name starts with `..`. Touched-file formatting and lint pass.

The broad integrator-file run retained its nonzero result: **31 passed,
2 timing failures** under load. JSON retained generic stack errors; the normal
reporter confirmed the dual-repo case timed out before install (empty
`gate-runner` log), with the governor reporting `load` at 4.832 times the cores.
Both exact failing cases subsequently passed without changing assertions or
30-second timeouts: CLI coalescing in isolation, dual-repo compose after the
sweep/queued gate finished (6.78 seconds). This is not a green broad run. The
integrator supplies the required exact-tree root landing gate.

Initial captures: [proof.json](proof.json). Extended cleanup, exact df output,
durable reclamation audit, checks, load evidence and verification limitation:
[cache-proof.json](cache-proof.json). Both are in the evidence manifest.

Deployment belongs to the lead. Ten full production landings after deployment
have not been observed; the ten-landing acceptance run used small real local
repositories to verify that build/install storage returns to zero.
