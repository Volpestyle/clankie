# VUH-2967: native issue metrics restored

The actual source CLI → production HTTP service → real local Claude/Codex
transcripts returns populated reports. The service used scratch HOME/state and
read links to local histories; no live tracker was copied or modified by this
proof. The owned governed server was stopped after capture.

| CLI query                                                | Issues | Workers | Observed pushes to main |
| -------------------------------------------------------- | -----: | ------: | ----------------------: |
| Review window: 2026-10-14 → 2026-10-29 00:00 UTC         |    203 |     168 |                      47 |
| Same window, `--project clankie`                         |    186 |     145 |                      46 |
| Rolling 14 days: 2026-10-15 03:24 → 2026-10-29 03:24 UTC |    211 |     175 |                      49 |
| Default 24 hours, captured 2026-10-29                    |     26 |      24 |                      10 |

After the final review guards, the rolling 14-day and project review-window
CLI captures were repeated: their counts and landing counts are unchanged. The
initial full-fleet/default captures remain in the manifest for comparison.

Before the fix, the installed CLI and current source both returned no issues or
workers. The current reproduction had 619 warnings: 52 remote histories, 117
unresolved local histories, 17 sources over 64 MiB, 432 native reads skipped
after the shared 256 MiB budget, and one budget warning. Historical-order
whole-file reads consumed the budget before recent hires. The assignment parser
also missed current saved Claude `clankieBrief` assignments.

The fix streams bounded native measurements, skips histories modified before the
window, reads current saved briefs, and preserves exact retained source joins.
It adds observed landing times, waits, exchanges, structured review decisions,
session/fleet totals, a present-time tracker/seat census, project filtering and
machine/session coverage. It creates no metrics ledger or source-discovery scan.

## Baseline comparison

The review's worker baseline is **Claude-only**, not the combined fleet. The same
baseline definitions applied to its 103 covered hired sessions produce:

| Measurement                    | Review baseline | Actual CLI cohort |
| ------------------------------ | --------------: | ----------------: |
| Worker wait share              |           33.7% |            33.86% |
| Waits per session              |             7.8 |              8.22 |
| Change verdicts / all verdicts |        73 / 231 |          73 / 231 |
| Review change rate             |          31.60% |            31.60% |

All three acceptance comparisons are within 10%. The covered cohort has 359.43
observed wall hours and 121.69 wait hours. Five VUH-2802 proof sessions have no
retained hire/tidy binding; one more baseline session starts after the fixed UTC
end (and appears in the rolling capture). The baseline collector selected by
mtime relative to its execution time, while this capture has an explicit end.
The project report's entire hired Claude cohort measures 32.90% wait share and
8.37 waits/session. Combined Claude/Codex totals have a different denominator.
The project report measures 8.10 worker/lead exchange attempts per issue episode.

Baseline sources: bundle
`clankie://evidence/sha256/029397d2d2ab509f3c2151c2d6cb3afd0db865bed9a842a421347fc2968d2f30`,
session table
`clankie://evidence/sha256/ad385b2fcfe7eaaca4960ad9166d7cf7fe94a1e4b2efa1126b00a3671bab1c0c`,
lead analysis
`clankie://evidence/sha256/ff8bc87b74a1a6a8c7ecd29a1f269749daf5ffcb20cba77ee0cacdfb6469a8b0`.

## Coverage and limits

- The full review report explicitly identifies 51 missing `pc` histories, one
  `kh2` remote history, and 117 unresolved local histories. These retained gaps
  span the history journal; absent transcript timestamps cannot establish which
  gaps belong inside this window. They are excluded, never counted as zero work.
- Three of the baseline's five native lead sessions have retained bindings.
  Their union gives **13.86% native busy fraction**, a coverage lower bound;
  this does not reproduce the complete 17.9% baseline. Inbox counts per UTC day
  have the same retained-source limit. Older unbound lead sessions are not guessed.
- The scratch service has no configured tracker projects or live fleet seats:
  `summary.current` reports unknown In Progress count, zero isolated seats, and
  warnings. This does **not** prove the live deployment's census. A focused
  integration check exercises the real tracker adapter and confirms its three
  In Progress rows are counted against two observed seats without changing
  tracker records. Unknown/incomplete live reads return null with warnings.
- A landing is a successful native fast-forward push to `main` correlated with
  the command that launched it. It does not prove every part of the issue shipped.
  Unsupported command wrappers and results collected through later shell polling
  stay unknown. Exchanges count attempts, not delivery confirmation. Waits include
  legitimate end-of-task pauses, exactly as in the baseline.
- Captures read live appendable transcript files. They are measurements at capture
  time, not immutable copies of private transcripts. No model calls or evals ran.

## Checks and reproduction

Focused integration checks cover the production service/client/CLI, exact source
aliasing, current Claude briefs, wait and review measurements, fake push output
rejection, correlated landing output, and read-only tracker census. Sable's review
found two additional boundaries: real Git dry-run output looked like a landing,
and a canonical brief filename could follow an outside symlink. The final
journey exercises real local bare-Git `--dry-run`, `-n`, quoted variants and a
real redirected push; it checks the origin ref and report together. Brief reads
use one no-follow descriptor, validate a bounded regular file, and reject an
outside-symlink fixture while accepting the regular-file control. The optional
starvation journey reads five bound histories totaling over 256 MiB and verifies
both the issue-specific and fleet-wide report remain populated without budget
starvation. It runs only when explicitly requested:

```sh
clankie heavy -- pnpm exec vitest run apps/clankie/test/issue-metrics-journey.test.ts apps/clankie/test/seat-issue-status.integration.test.ts apps/tui/test/metrics-cli.test.ts
clankie heavy -- env ISSUE_METRICS_STARVATION_TEST=1 pnpm exec vitest run apps/clankie/test/issue-metrics-journey.test.ts
```

The real-data capture used `scripts/scratch-stack.mjs` for an isolated preset,
then the evidence flow `prepare-proof.mjs` to copy only metrics state and link
transcript roots. The production service ran through `clankie heavy --server --`.
The actual CLI was `node scripts/scratch-stack.mjs run .local/vuh-2967/stack cli
metrics --issues`, with the dates/project flags above. The flow assumes James's
local source paths. Never copy credentials or use the live HOME/state for the
service. The live runtime was not restarted or deployed during capture.

Raw JSON, summary, focused logs and proof flows are in the evidence manifest;
only this README and `evidence.json` are committed. The issue records the landed
commit, exact review approval and landing gate result.
