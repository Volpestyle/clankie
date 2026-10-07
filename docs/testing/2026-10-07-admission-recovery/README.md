# VUH-1805 admission recovery and refusal floods

Local admission now distinguishes unavailable observations from a definite
non-member. Unavailable proof returns HTTP 503 `fleet_admission_unavailable`
with `retryable: true` before dispatch; Claude and Codex retry that request once
after one second. A definitive HTTP 403 `local_process_membership_required`
asks the worker to inspect admission with the lead and stops automatic polling.
Lost replies and uncertain earlier receipts still require reconciliation.

Worker hooks check pane presence before claiming a seat. An exact Herdr
`pane_not_found` leaves a worker unclaimed; transport failures remain unknown
and cannot grant access. This covers pre-warmed workers with inherited stale
pane IDs. Aggregate proof refusal alerts count all terminal outcomes, regardless
of current pane ownership. They retain an owner notice and preserve native
receipt uncertainty and cooldown.

## Live investigation

Runtime `4b9c935f` started at 2026-10-07 19:02:38Z. At 19:21:17Z its metrics
reported 1,331 refusals out of 9,984 attempts: 1,313 `pane_unavailable`, 16
`not_member`, one `native_initial_unavailable` and one
`native_final_unavailable`. The five-minute rate was 14.37% (58.2 refusals/minute).
Two background Claude worker bridges claimed the same pane that Herdr reported
missing. Both were still connected to the local listener, beneath pre-warmed
spare sessions. Twelve active panes had matching bridges. Their automatic
polling continued after definite membership rejection.

The lead stopped those two bridges with owner approval around 19:27Z; this
worker did not stop or restart any runtime. The before/after comparison below
measures that intervention, rather than claiming deployment of this patch.

Matched service-log windows showed:

| Window (UTC)         | Refusals | Per minute | Fleet missing-pane | Project unavailable |
| -------------------- | -------: | ---------: | -----------------: | ------------------: |
| 19:21–19:26 (before) |      358 |       71.6 |                120 |                 237 |
| 19:28–19:33 (after)  |      116 |       23.2 |                  0 |                 115 |

Each window also contained one fleet `native_initial_unavailable` refusal.
The intervention reduced the total flood by 67.6%; this is an estimated share
from the change in observed counts, not individual request correlation. At
19:33:31Z the latest five-minute metrics window reported 103/1,858 refusals
(5.54%, 20.6/minute), all `pane_unavailable`. Metrics use current minute buckets,
so their window differs from the matched complete five-minute log intervals.
The 115 remaining project refusals cannot be assigned an exact cause or caller.
Before/after counts are retained in `.local/vuh-1805/before-after.json`.

Logs omit pane IDs intentionally, while the collector receives them. A missing
log field is not proof that a request lacked a pane. Project observation failures
also collapse multiple causes into `pane_unavailable`, so remaining failures
cannot be assigned to a caller from these logs alone. The existing seat alert
requires a current native pane and lead route; obsolete callers could not alert.

Sanitized private provenance is retained in
`.local/vuh-1805/provenance.json`, with raw account and environment data omitted.

## Verification

All checks used `clankie heavy`:

- 36 server integration tests passed across
  `local-fleet-admission-cancellation.integration.test.ts`,
  `local-fleet-mcp.integration.test.ts`, `fleet-health-metrics.integration.test.ts`
  and `fleet-lead-round.integration.test.ts`.
- 38 bridge integration tests passed across
  `inbound-seat-recovery.integration.test.ts`,
  `worker-bridge-concurrency.integration.test.ts` and
  `worker-bridge-health.integration.test.ts`. The connected-call regression
  proves a transient refusal retries the exact request twice with one provider
  effect; a definite refusal dispatches nothing. Mailbox and catalog requests
  go quiet on definite refusal while temporary refusal and shutdown remain
  recoverable. Denied receipt lookups retain the original uncertain receipt.
- Seven `worker-next-turn-hook.test.ts` cases passed, including real hook
  subprocesses against native Unix sockets and loopback HTTP.
- One opt-in native proof test was skipped; no native helper implementation
  changed. This is integration evidence, not a live production admission replay.
- Service and TUI typechecks passed. Scoped formatting, lint and diff checks
  passed; all 493 Markdown files resolved local links.

The initial combined bridge gate failed on variable declaration/reference
errors and fixture request accounting; those were corrected before the final
runs. Unchanged passing suites were reused. Private logs retain both failed and
passing runs under `.local/vuh-1805/`.

The frozen dependency install passed with its lockfile unchanged. No deployment,
restart or live provider mutation was performed. Project-bound peer proof stays
separate; failures after an admitted call retain receipt reconciliation semantics.
