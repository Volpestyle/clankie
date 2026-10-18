# VUH-2460 — landing keeps timing proofs for release

Tracks: https://linear.app/vuhlp/issue/VUH-2460

The six issue-named timing-sensitive files are listed once in
scripts/testing/landing-test-policy.ts. They are on main at
bd1ab027bc3370f4f094a28ffa04f2ebbbe0d600. The shared Vitest configuration
applies the landing policy to parallel and serial projects. Plain pnpm test
and release checks retain every moved file. Existing assertions, deadlines,
product defaults and eval boundaries are unchanged.

## Verification

Real native Vitest discovery proves all six remain in manual selection and
leave landing, while cheap runtime-canary, fleet-refresh and remote-queue
controls remain. Eval and opt-in computer tests stay excluded in both modes.
All 13 discovery/revalidation cases pass; the typed policy also passes its
settings import compiler and native discovery test. Discovery executes no eval.
The actual six-file candidate's exact-tree root gate is green: 28.15 s, stable
source, settings compiler passed. A preceding JS declaration error was fixed
with a typed policy; no compiler check was weakened. Full logs are retained in
same-change-comparison.json; initial red/green discovery is discovery-proof.json.

## Same feature, before and after

The after-policy proof places the policy in its base, then applies the exact
original VUH-2462 feature patch. Git patch ID is identical:
9dfb08d05509342b706bb2b2fbe5016fa32626f4. Product/test source under apps/clankie,
apps/tui and packages is byte-identical. Comparison refs are local proof refs,
never pushed. The actual policy candidate differs only in evidence docs.

| Observed phase   |   Before |    After |
| ---------------- | -------: | -------: |
| Whole root gate  | 590.44 s | 166.90 s |
| Compiler phase   | 376.33 s |   0.47 s |
| First test phase | 190.28 s | 149.42 s |
| Selected files   |       95 |       94 |

The only selected-file difference is fleet-lead-round (27 cases). Before:
652 pass/8 skip after one supported runtime-terminals retry. After: 625 pass/8
skip after one supported cache-reclaim retry. The latter correctly kept an
unverified cache when native process census failed with errno 1; its unchanged
isolated case passed. The full gate saving is largely warm compiler cache, not
all caused by this policy. The observed first-test phase difference is 40.86 s;
load and different retry conditions prevent a controlled causal speedup claim.
Raw gates, selected files, retries and exact patch checks are in
same-change-comparison.json.

## Measured history decision

The read-only snapshot has 722 history records: 533 gates, 272 nonzero outcomes,
starting October 10. A bounded metadata scan found 138 completed, deduplicated
gate reports; 15 identify file failures, including recovered attempts, across
13 files. This does not establish complete two-week attribution. The classified
failures, source references and observed slow-file samples are in history-review.json.

No additional exclusion or transitive integration cap is justified by this
partial evidence. Runtime-provider has a contract assertion and unresolved
cleanup error; Codex has a mock import failure; provider, bridge, power and SSH
assertions are not established flakes. A Discord timeout shares a HEAD with
passes but has different uncommitted source fingerprints. Runtime-terminals has
a supported recovery but a normal median of 1.584 s and protects pinned routing.
Native process-census refusal is a safety result. Keep those checks. Recent
remote-queue regression coverage and sparse slow-file samples also do not prove
absence of useful catches. The roster lifecycle regression required the real
source fix bc4025758; preserve its broader coverage.

Missing per-file history remains unknown, not a flake or proof of no catches.
The app's stale clankie-ops baseline is setup drift and needs no test removal.
No full release suite was rerun: native discovery proves unchanged manual/release
selection. No eval, release, deployment or live retirement was performed.
