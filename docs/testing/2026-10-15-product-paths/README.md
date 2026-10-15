# VUH-2280: project product paths

Tracks: https://linear.app/vuhlp/issue/VUH-2280

Product paths are optional repository-relative globs, edited by the revision-fenced
project API, `clankie project update`, and the TUI's Product paths field. The CLI
reads the autonomy-aware view; the plain API view strips the declaration and
capability. `null` restores default classification. Velocity passes the declaration
to the churn reader for both churn totals and closure classification.

Source landed on `main` at `68097403793c454829eba82efe454e45431fde70`
(feature `82917e136`, validation lint fix `680974037`), rebased onto
`35551ada40867e871c5786a87e85dc6f173d167a` before push.

## Verification

**Isolated passes:**

- Initial focused checks: 5 files, 14 tests passed. Real loopback HTTP, file-backed
  settings and broker exercise CLI set/read/clear, stale revision rejection,
  invalid path/count/length rejection, and plain strict-client parsing. The TUI
  flow edits through the real project routes. A real tracker and git history
  prove the setting changes churn and closure classification.
- After rebasing: 8 files, 75 tests passed, including those product boundaries,
  resource CLI, merge-gate scheduling, simulator admission, heavy admission and
  release-check recovery touched by the incoming VUH-2291 change.
- The original root gate passed all 24 selected package typechecks. Rebased TUI
  and fleet-resources typechecks passed. Explicit formatting of all 12 touched
  source, test, guide and skill files passed on the rebased tree.

**Full-gate result:** nonzero, accepted under the assignment's known-failure
exception; never a green product landing gate.

- Required root `clankie heavy -- pnpm check:landing`, checked HEAD
  `6a13b50b641171c0828e2a3bc26ef956328479e0`, fixed base
  `6edbcf19df9d7ddab28bbd25328d448cbf183204`: exit 1, 559.73 seconds.
  Skills, formatting, lint, dead-code, docs, evidence checks and all 24 affected
  package typechecks passed. Tests stopped at VUH-2299: 44 files and 1,468 tests
  passed, one failed, 34 tests skipped before bail.
- Optional no-bail run on that same tree: the first full test run completed in
  1,683.54 seconds: 721 files / 6,494 tests passed, 31 files / 83 tests skipped,
  two failing cases (VUH-2299 and VUH-2300). The lead authorized stopping the
  automatic whole-file retry; recovery is **incomplete**, overall exit 1 after
  1,739.37 seconds. No assertions, deadlines or defaults were weakened.
- VUH-2299: owner-started cwd membership at line 129 returned
  `unknown/timeout` instead of `member/workspace/repo/builder`. The exact case
  reproduced that result on the changed tree and an unchanged export of its
  `6edbcf19d` main base. A refreshed current-main `35551ada4` export also failed
  at the membership deadline, surfacing `Membership deadline` rather than the
  earlier result assertion. Its 4,288 tracked blobs matched that revision.
- VUH-2300: the reclaim case for more than 32 historical trees failed identically
  on rebased `680974037` and unchanged main `35551ada4`: test timeout 120 seconds,
  afterEach timeout 30 seconds, aroundEach teardown timeout 30 seconds; both exact
  runs took about 183 seconds. VUH-2306 cases passed in the full first run.
- Revalidation refused the recorded non-green gate. The lead explicitly
  authorized rebasing and focused incoming-delta checks instead of repeating all
  754 selected files. The 75-test rebased check and affected typechecks above are
  that follow-up. Load snapshots and the actual nonzero results are retained.

## Live KH2 acceptance

**Passed against the running service.** The lead reported deployed revision
`80a2f527e` healthy, containing the implementation and its earlier evidence.
The source CLI advertised `productPaths: true`, read the existing
`kh2-multiplayer` project with no declaration, then submitted the seven requested
paths through `project update` with the exact revision it had read. A separate
`project list` returned the same saved list and revision as the update:

```json
["inject/", "common/", "server/", "runtime/", "tools/launcher/", "tools/packaging/", "content/"]
```

Before revision: `8f63ecf92170482b8642059bc77a23e31d9267ac5efbd3516f7a2ce3a3d39f86`.
Update and independent readback revision:
`b1395efcdc3343331066ca4ca441cdaeb27aae0c8687ff273376edca78c4a1df`.
All three source CLI commands exited 0. The capture retains their commands,
completion times, capability, project ID, values and revisions; unrelated
settings and credentials are omitted. There are no remaining acceptance gaps.

## Captures

The evidence manifest links the raw gate output, baseline comparisons, focused
checks, compiler results and machine-load snapshots. No evals ran. Temporary
HTTP listeners were closed by their tests; the worker did not restart the live
service.
