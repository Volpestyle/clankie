# Fleet proof refusal attribution — VUH-1704

The residual alert was real, but its `pane_unavailable` classification was too
broad: project proof used it for every unsuccessful initial observation. The
patch distinguishes native pane-not-found from binding, harness, launcher,
foreground, process/session changes, malformed observations and transport errors.
Admission and the aggregate alert threshold remain unchanged.

## Observed rates

| Window (UTC, 2026-10-07)  | Runtime / scope                        | Refusals / attempts | Rate  |
| ------------------------- | -------------------------------------- | ------------------- | ----- |
| 20:55 aggregate report    | Previous runtime, five minutes         | 93 / 1907           | 4.88% |
| 21:00 aggregate report    | Previous runtime, five minutes         | 97 / 1718           | 5.65% |
| 21:27:49.416–21:34:07.084 | `1807ac10`, settled, before this patch | 0 / 2340            | 0%    |

The owner's deploy passed its canary at 21:25:23.945Z. Its settled baseline above
covers 6 minutes 17.668 seconds. The earlier `pane_unavailable` flood ended at
21:03:50.445Z, before that deploy; observed residual refusals were project proof
at roughly 22–24/minute. Existing logs cannot identify their exact processes,
panes or request routes. Current connected bridges are not evidence of historic
senders. The zero baseline predates this patch and is not an improvement claim.
After-patch rate awaits the next owner deployment.

## Later low-volume alert

At 21:50:53Z the owner reported a 5/92 five-minute alert. The same runtime
still had coverage starting at 21:19:21.154Z; its global five-minute snapshot at
21:51:24.443Z was 7/1580 (0.44%), not a restarted 92-call global window. The
reported smaller denominator is consistent with the separate per-seat alert.
Four project `not_member` refusals occurred at 21:47:38–39 and three fleet
`native_initial_unavailable` refusals at 21:49:13 and 21:50:53, while machine
load was above resource admission limits. None was `pane_unavailable`.

The project burst coincides with a new hire, but old logs cannot prove its
sender. A minimum call count could limit low-volume rate alerts; these
observations do not establish that the refusals were expected noise, or justify
an arbitrary cutoff that would hide a newly broken seat. Keep this alert-policy
question open until post-deploy request attribution identifies the callers and
stages. The patch leaves the current 1% threshold unchanged.

## Changed evidence surface

Server-generated request and connection IDs join private project-stage diagnostics
to refusal context. Fixed route/method identify the request type; operation
separates fleet from project proof. Validated pane and bridge claims are explicitly
claims. Kernel PID/process birth includes observation time and whether it is a
fresh sample or previous observation. Missing attribution remains `unknown`.

Successful proof reuses its already-observed socket owner only for diagnostics.
Cold refusals add at most one sample per connection, 12 new connections/minute,
and two concurrent native reads. Diagnostic data cannot authorize requests.
Counters retain fixed labels, with no PIDs, paths, argv or credentials. Private
logs exclude paths, argv, credentials and request bodies; actual machine identity
receipts remain in ignored `.local/fleet-proof-refusals/`.

## Verification

Focused service typecheck and proof/metrics/cancellation checks passed (36 tests).
The final real-socket attribution and project-observer checks passed (31 tests),
including native pane-not-found versus transport failure, forged PID rejection,
and historical attribution when the same TCP connection reuses its sample.
Request-context boundary checks passed (11 tests); three selected real worker
bridge subprocess checks passed. `pnpm check:landing` passed: formatting, lint, deadcode, docs, all 29 package
typechecks, and 321 affected tests across 28 files (56.81 seconds). Its existing
manual/opt-in guards reported seven skipped files and 11 skipped tests; this
patch introduces no skips or retries. No full gate,
evals, deployment or restart is part of this follow-up. VUH-1704 stays open for
its remaining acceptance and the after-deploy observation.
