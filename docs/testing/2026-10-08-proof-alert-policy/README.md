# Proof alert source and startup policy

James reported a live owner-TUI proof alert at `2026-10-08T03:53:56Z`:
`2/194` refusals over five minutes. This is owner-observed delivery evidence,
not a simulated receiver or a claim that a later policy is deployed.
The window included three fresh hires and simulator cold boots, with reported
machine load around 200 on eighteen cores.

At `03:54:17Z`, James's `clankie metrics --fleet` read showed `13/1214`
(1.07%): eight `not_member`, four `native_final_unavailable`, and one
`native_initial_unavailable`. This worker independently read `13/1179` at
`03:54:06.118Z`, with the same reasons. Raw private receipt is retained under
`.local/report-health/live-metrics.json` in the reconciliation worktree.

## Why the counts differ

`onProofAlert` uses one caller pane's five-minute buckets and routes to that
seat's current owning lead. `onAggregateProofAlert` uses all local fleet and
project checks, including requests without a current identifiable pane, and
routes to the owner's default conversation. `clankie metrics --fleet` and
doctor show the aggregate. Later reads also include subsequent checks and can
expire old minute buckets. The reported wording matches the old per-pane alert template; the aggregate
template explicitly said “across all local proof checks.” This is a source
inference from the supplied wording, not a recovered original alert envelope.
A per-pane count is not required to equal the aggregate at a later timestamp;
timestamp differences also prevent exact comparison. The new text makes both
sources explicit so the next live sample can be attributed directly.

The existing aggregate path is already on main from VUH-1805 (`ac8408d0`).
Pane-less refusals are counted and can alert. It retains an owner service notice
when no native route exists; this durable fallback is separate from James's
observed live native delivery above.

## Reversible product decision

Count every refusal. Alert when the five-minute window has at least 100 checks,
at least five refusals, and stays above 1% for at least one minute. Both worker
and aggregate paths use this rule. An observation below any guard resets the
persistence period. The next qualifying refusal can dispatch after that period.
No receipt is resent while unconfirmed; the existing acknowledgment and accepted
delivery cooldown semantics remain intact.

The sparse `2/194` startup sample stays visible without paging. Startup and high
load do not create unconditional exemptions: a legitimate outage can first
appear during either condition. Caller startup claims cannot disable alerts.
Sustained overload still qualifies. The sample floors and persistence interval
are fixed code defaults, rather than new owner settings.

Worker alert text now names its worker scope, timestamp and guards. Aggregate
text names the same source as `clankie metrics --fleet`, with bounded fixed
reason counts. This changes notification policy only, never admission,
membership validation, refusal counters or private attribution.

Decision recorded on [VUH-1704](https://linear.app/vuhlp/issue/VUH-1704#comment-d751d605-3459-4155-891a-dfc6169a9d1b).

## Verification

The focused integration checks cover the owner-grounded sparse sample, real
TCP refusals, the 100-check floor, the one-minute persistence boundary,
pane-less inclusion, aggregate alert/HTTP window equality, and exact receipt
holds and cooldowns after qualifying samples. Final check results and landed
commit are attached to VUH-1704. No simulator or eval is required.
