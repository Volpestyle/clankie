# Worker worktree reconciliation — 2026-10-08

Scope: [VUH-1814](https://linear.app/vuhlp/issue/VUH-1814) and the dirty-start
diagnostics overlap with [VUH-1744](https://linear.app/vuhlp/issue/VUH-1744).

## Preserved earlier work

Fetched `origin/main` started at `f8d400eff2b2dd45ac41c802c9e77cc1adac960f`.
For each assigned old worktree, both `git cherry origin/main` and
`git log HEAD --not origin/main` returned no commits. Every old commit is an
ancestor of main, a stronger proof than patch equivalence. All three trees
were clean; their files and ignored evidence were left in place.

| Assigned worktree                          | HEAD                                       | Disposition     |
| ------------------------------------------ | ------------------------------------------ | --------------- |
| `clankie-wt/vuh-1814-landings`             | `379971431f6657f01b9abadb529c46dbca019a69` | Already on main |
| `clankie-wt/vuh-1814-reconcile`            | `b648d2f32e8148e0715deca84a5e6d837b2b8f42` | Already on main |
| `clankie-app-wt/vuh-1814-landings/clankie` | `6931c86e2f3a7aef2662b89abe4f56edebcf8057` | Already on main |

No cherry-pick or abandonment was necessary. The existing close refusal,
decision ledger, doctor report, evidence archive and guarded prune remain the
implementation used by this change.

## Merge content protection

`git cherry` omits merge commits. The new integration fixtures create a merge
with `resolution.txt` present only in that merge, then cherry-pick all ordinary
patches onto main. They establish no unlanded (`+`) `git cherry origin/main` entries
while the unique resolution is still absent from main.

Reconciliation now counts non-ancestor merges as unlanded. Close refuses
`unlanded_work`, and tidy/prune keeps the tree as `unmerged`. The deliberate
drop fixture records a HEAD-matched reason, removes the tree through the
existing guarded prune and reads the resolution back from
`refs/clankie/dropped-worktrees/<HEAD>`.

This is conservative: a rebased merge whose content was independently landed
still requires explicit review or landing its ancestry. Ordinary rebased and
cherry-picked commits retain their existing patch-equivalence behavior.

## Dirty hire admission

Clean starts remain required. Local and SSH dirty-start refusals now name up
to 20 blocking paths, grouping untracked directories. Real-repository fixtures
cover `.tmp/` and `dynamodb-local-metadata.json` and verify the files and Git
status survive observation. No scratch-file allowlist, deletion or edit to
`project-hires.ts` was introduced; allocation recovery stays in VUH-1826.

## Earlier backlog and mailbox

The two existing VUH-1814 evidence comments retain the initial 67-tree triage,
16 durable worth-landing/drop decisions and the subsequent guarded landings.
The ledger was read again during this assignment; it still retains those
reasons. This change does not reclassify work as landed from a matching subject
or author timestamp; those are leads for review, not content proof.

The lead reports owner-mail update `91f9579f-b840-4ccc-b216-49b652f215ce`,
“5 old worktrees still hold unlanded work,” linked to VUH-1814. It names
`vuh-1594-pair`, `vuh-1606-pair`, `ari-desktop-20261005`, `macos-083` and
`vuh-1542`, with the rebase, validation or decision each needs. This supplies
the deliberate mailbox handoff required by ADR 0245. No automatic mail event
was added. Mail publication is lead-reported evidence, not a worker-observed
mailbox API result.

## Verification

Focused verification passed through `clankie heavy -- pnpm exec vitest run`:
5 files, 42 tests, covering settings checkout reconciliation, local/SSH hire
freshness, pane close, guarded tidy/prune and receipt failure reasons.
Formatting passed on changed files.

The first landing run passed 3,313 tests before failing an existing successful
receipt case in `fleet-report-reasons.integration.test.ts`: its 100 ms fixture
deadline expired under shared-machine pressure. Non-timeout fixture requests
now allow 2 seconds; the two deliberately delayed timeout cases keep their
100 ms deadlines against the existing 250 ms server delay. Production receipt
behavior is unchanged. The original failure log is retained in
`.local/vuh-1814-landing-first.log`.

The required `clankie heavy -- pnpm check:landing` result and landed revision
are recorded on VUH-1814; the raw local gate log is retained in
`.local/vuh-1814-landing.log` in the worker checkout.

VUH-1744 remains open for its full acceptance: the original automatic sync
hooks are on integration-queue pushes; direct ADR 0240 pushes require the
documented `clankie checkouts sync` step. This assignment does not prove
automatic synchronization after every direct push or every live-hire path.
No deployment, service restart, simulator run or eval was performed.
