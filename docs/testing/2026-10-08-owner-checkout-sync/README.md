# Owner checkout sync and fresh hire starts (VUH-1744)

This continues the [worktree reconciliation evidence](../2026-10-08-worker-worktree-reconciliation/README.md).
Earlier landed work supplies safe owner fast-forward, guarded pruning,
retained owner/age reporting, and doctor/roster checkout counts.

## Change

The service observes registered local owner `origin/main` refs every five
seconds. A direct push from any linked worktree changes the shared ref and
triggers existing safe sync. A fetch once a minute catches other clones and
machines; startup catches missed pushes. Rapid advances can coalesce to the
latest main. No hooks or shell command interception are installed. Blocking
files and their ages produce a service notice and log. Repeated observations of
the same warning stay quiet; a new main triggers another sync attempt. Manual
`clankie checkouts sync` remains available.

Fresh hires fetch main on the actual machine. A clean behind-only checkout, including
detached HEAD, safely fast-forwards after a complete live-pane census.
Foreground directories and symlink aliases protect live work. Dirty and divergent
starts refuse; live, managed-runtime, ignored-collision and unverified checkouts
never auto-advance. No stash,
reset, force update, autocommit, ignored-file deletion or saved-session move is
used. The brief receives the resulting verified HEAD and fetched main.

Teo was notified through `message_peer` at seat `term_65d4c24e348a2a7`
(delivery `40b05c4f-a990-469c-8122-dce5255133a9`). His acknowledgement confirmed
no overlap in checkout helpers or `captain.ts`. He changed his VUH-1826 refusal
fixture to clean divergent work. Allocation changes in `project-hires.ts` and
`herdr-watch.ts` remain his ownership.

## Verification

`clankie heavy -- pnpm exec vitest run` on the settings checkout, service
checkout-freshness and owner-checkout-sync integration files passed: 3 files,
11 tests. The affected-test rerun including SSH OpenCode lifecycle passed:
4 files, 31 tests. The first landing gate passed static/docs checks and all
29 typechecks, then found the SSH fixture exact-command whitelist needed the
new live-cwd argument. Its whitelist now includes the actual fixture cwd and
still executes the real remote program. A later gate reached Teo's divergent-hire
regression and found a refusal-message compatibility mismatch. The checkout
helper now preserves the old prefix and adds the precise divergence explanation;
the covering rerun passed 2 files, 8 tests, with 1 existing opt-in test skipped.

### Baseline investigation; no exception used

The feature's default gate failed at `device-subscriptions.integration.test.ts:375`
(`expired` expected, `failed` received). A subsequent gate excluding only that
file failed at `worker-call-receipts.integration.test.ts:333` (`ok` expected,
`refused` received). These files were not edited here. The receipt file passed
alone on the feature: 15 tests. [Failure output extracts](feature-failures.txt)
include the commands, assertion diffs and summaries.

James permitted a narrow exception only if each failure also reproduced on
clean main and the rest of the gate passed. A separate clean detached worktree
at fetched `3407a76a625858f62c3c43ce77959f1631c9f7fe`, without this feature,
installed its own dependencies through `clankie heavy -- pnpm install`.
The subscription file passed alone: 6 tests ([command/output](baseline-subscriptions.txt)).
The receipt file also passed under the same four-worker configuration and the
explicit feature-gate file selection: 453 files, 4,148 tests; 11 files and
31 tests skipped ([command/output](baseline-loaded-receipts.txt),
[selection](baseline-selection.txt)). The one new observer test file is absent
from baseline. An earlier reverse `--changed` comparison selected zero tests;
that attempt is not counted as evidence.

Neither required baseline failure was reproduced, so the exception is not used.
James directed rebasing onto the pending-deadline catch fix, `6912e691`, and
including the subscription file in the next gate. The observer starts only in
`index.ts`, which the subscription test does not start; the hire changes do not
enter the sign-in path. This establishes no direct path coupling, not the exact
historical timing cause. The pending provider/session timeout callbacks can race;
the landed fix makes the elapsed pending deadline authoritative in catch.
Ash's separate receipt fixture deadline fix landed as `b60e2104`; its controlled
timeout trace is recorded in his
[evidence](../2026-10-08-worker-receipt-baseline/README.md), rather than claimed
as proof of our historical failure.

### Final gate

After rebasing onto main `739322ea`, including Juno's `6912e691`, the gate found
the newly landed installer entrypoint missing from Knip's launcher entries.
`install.sh` invokes this helper and `scripts/build-release.mjs` builds it;
A temporary local Knip registration allowed verification to continue. James then
confirmed Saga owns this registration; the duplicate is removed from this change.
Saga's `c8169521` supplies it on main. Installer production files
were not edited here.

`clankie heavy -- pnpm check:landing` on candidate `d8f7a794` passed with **no
exclusions or retries**: formatting, lint, dead-code, docs checks, all 29 workspace
typechecks, 455 passing test files and 4,166 tests. There were 11 existing skipped
files and 31 skipped tests. Both previously failing files were included.
[Command/output](landing.txt) records the result.

The subsequent rebase onto Ash's `b60e2104` was conflict-free and changed only his
receipt test and evidence. The focused combined-tree rerun passed **10 files,
85 tests**, with one existing opt-in native allocation test skipped, in 55.12s.
[Command/output](rebased-focused.txt) covers checkout advancement, remote lifecycle,
the allocation refusal regression, subscription expiry and four worker receipt/
bridge files. James subsequently required another full landing gate after
integrating Saga's independently owned Knip registration. The rebase onto
`c8169521` was conflict-free, preserving her actor/audience and room-skill
restrictions. This change has no Knip diff. The integrated gate command and
result are recorded in [final-landing.txt](final-landing.txt); the earlier gate
is retained as historical evidence.

Real Git fixtures cover repeated direct pushes with automatic owner advancement,
disjoint untracked owner work, overlap warnings with ages and deduplication,
separate-clone fetch catch-up, local main and detached hire advancement, local
commit preservation, ignored collisions, clean topic branches and live-owner
refusals. The SSH program runs as a real Node child and protects a live cwd
reached through a symlink and an unavailable census before advancing a clean
behind-only checkout.

## Runtime boundary

The service observer starts in the production entrypoint and stops with service
shutdown. The installed service must load the landed source through the normal
owner/lead deployment route; this worker does not restart existing lanes.
