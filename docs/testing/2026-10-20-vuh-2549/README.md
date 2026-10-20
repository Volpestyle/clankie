# VUH-2549: canonical dependencies in composed batches

Tracks: https://linear.app/vuhlp/issue/VUH-2549

The real failed batch `cafb726e-1dfd-4325-b9de-b28da377990b` installed core
successfully at 09:30:54–09:31:12Z, then app at 09:31:12–09:31:37Z. Its core
fixture manifest contained 79 `../clankie-app` inputs. Core's protocol Zod link
resolved to the app's private store. These records and the manifest were copied
read-only before the finished batch's worktrees were reclaimed. Git stores and
logs remained available.

The app workspace includes sibling core packages, so its pnpm install rewrites
their dependency links. Composed integration now installs app first and core
last, restoring core's canonical links before either gate. Gates and pushes
remain core first, then app. Frozen lockfiles, private stores, copied packages
and fixture manifest admission remain unchanged. Manual paired-worktree setup
uses the same order and repeats core's frozen install after a later app install.

## Verification

A real paired pnpm/Zod regression failed before the fix: both installs succeeded,
but core's gate detected a dependency resolving outside core. With the new order,
that regression and six existing composition, install-failure and gate-reuse
checks passed. Both repositories consume the real Zod schema successfully.

The full-repository proof uses owned snapshots of core and the recorded app
commit, local bare origins, the actual changed IntegrationQueue and its native
gate driver. Only the disposable sources' gate entrypoints are narrowed: core
runs the unchanged fixture-admission boundary and corrective suites; app runs
its real core-sibling check. No runtime, live batch or fixture trust code is
modified. The enclosing `clankie heavy` command owns the host permit; nested
runners reuse the repository's fixture governor and private resource journal.

Proof batch `2f67033a-848d-445d-bc51-04d679219d5c` passed all 22 unchanged core
fixture tests and the app's core-sibling check. Its generated manifest has 237
inputs and zero escaping paths; protocol's Zod link resolves inside core's own
node_modules. Recorded phase receipts show app installation before core, and
core's gate before app's gate. The first full-pair run passed 21 tests and failed
one legitimate read with HTTP 403 after successful issuance. The unchanged full
repeat passed all 22; both logs are retained. Assertions, deadlines and fixture
trust code were not changed.

Final proof results, checked commit/base and landing receipts are recorded on
the issue with durable evidence links. Raw logs belong in the evidence store;
only this README and the receipt manifest belong in Git.
