# Auto milestone reporting landing — VUH-2286

Tracks: https://linear.app/vuhlp/issue/VUH-2286

Code: `c415d25bf` + `c5786bcac`, finally rebased onto `b482637c93c360eef650d59e56760e6cdca02a7c`.
The earlier request/link and KH2 replay capture is in [the feature proof](../2026-10-15-auto-milestone-reports/README.md).

## Full-gate result

**Non-green, accepted under the lead's explicit VUH-2306 exception.**

The required root `clankie heavy -- pnpm check:landing` checked HEAD
`6fe7ee39d9d34e0a2a12063a2453917da4494006` against fixed base
`80a2f527e3ef0dbc186b8e15da9c939e2ab8d87a`: exit 1 after 1,392.80 seconds.
Formatting, lint, dead-code, docs and all six selected package typechecks passed.
Tests: 244 files / 1,827 tests passed; one failed; two files / seven tests skipped.
The only failure was `integrate.integration.test.ts:1715:40`,
“ten consecutive landings remove scratch trees immediately, keeping logs, records and restorable commits”:
`Test timed out in 120000ms.` No assertions, timeouts or product defaults changed.

An earlier gate stopped at a type error in the new proof fixture. That error was fixed in the second code commit; the subsequent six-package typecheck passed. Both historical results are retained and labelled in the log.

## Unchanged-main reproduction and authorization

The exact VUH-2306 case failed identically on an isolated export of unchanged
`8dce245f6`: `Test timed out in 120000ms.` at the same line; exit 1, 132.42 seconds.
All 4,297 tracked blobs matched that commit before and after the run. The export
used its own real frozen-lockfile dependency install, with no links to another checkout's caches.
This is a failed main comparison, not an isolated pass.

The lead explicitly approved landing only after that identical unchanged-main
failure, and instructed that after rebasing onto `8dce245f6`, revalidation plus
focused milestone suites sufficed without repeating the full root gate.
The rebase was clean. `--revalidate` exited 1, correctly refusing the recorded
non-green gate (and reporting missing selection recording); this is not a green revalidation.

## Isolated passes

After the rebase, the two milestone suites passed **12/12 tests**, exit 0,
12.44 seconds. They cover closed parents, the captured KH2 “Shared world” milestone
at `2026-10-15T01:44:38.451Z`, batching, idempotence across rounds/restarts,
refused and unsettled requests, tracker rebinding, routine/extra post flags,
velocity windows, and a running captain's native-channel / tracker / HTTP request-and-link flow.
Native independent review found two bugs (uncertain delivery and tracker rebinding);
both were corrected and the reviewer reported no remaining blockers. The overlapping
VUH-2310 capacity prompt was independently reviewed after the earlier rebase.

The first push was rejected when VUH-2300's native cwd census fix `b482637c9`
advanced main. After another clean rebase, the focused suites passed **12/12**
again (exit 0, 10.20 seconds). Revalidation again refused the historical non-green
gate. No full root gate was repeated under the lead's instruction. The failed main
comparison above predates `b482637c9`; this record does not claim that VUH-2306
still fails with that fix. `post-2300-focused.log` retains the final source heads,
focused results, native request/link capture and revalidation.

## Gaps and limits

- Deployed KH2 Auto proof remains unperformed; the KH2 evidence is replay, and the running-service proof uses an isolated built-in project. No runtime restart or deploy-hold change was made.
- VUH-2256 owner-loop cadence remains conditional on that future setting; default milestone cadence ships here. VUH-2284 slice 2 is not used.
- An ambiguous post-guard delivery stays claimed and unsettled to prevent another ask; this can leave a request unreceived. Update association does not validate author or body media/evidence.
- No evals ran. Tests used isolated fixtures; this feature was not submitted to the live integrate queue.

`landing-evidence.log` retains the exact gates, failed baseline, source verification,
revalidation, final focused pass, independent review and resource samples.
