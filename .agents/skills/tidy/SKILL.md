---
name: tidy
description: Tidy finished Clankie worker panes and list merged, clean worktrees after harvesting or when asked to tidy up. Judge work and keep reports before closing; preserve owner drafts and interactive panes.
quick-action:
  name: Tidy up
  icon: broom
  selectionArg: selection
---

# Tidy the fleet

Read the current roster, the selected panes if any, and their reports. Decide
which workers have finished useful work and whose results are kept. A settled
status is a cue to inspect, not proof of completion. Keep a worker around when
follow-up work would benefit from its live context. You can tidy after harvesting
without waiting for the owner to list panes or approve each close.

Acknowledge a report only once you have its result; that is what lets the pane
go. The service also tidies on its own under the owner's `autoTidy` fleet setting
(default `1h`), through the same guards, and only with positive work proof: a
kept report, every report acknowledged, and landing proven by advertised
`origin/main` ancestry or a retained current-HEAD decision covering every
unlanded commit. Missing or non-Git working directories and incomplete
observations hold the pane; never infer no work from an empty result. Where the
owner turned automatic tidy off, leave it off until they decide otherwise.
When a worker's live context is worth keeping, or the owner asks, call
`keep_worker_pane({ pane, reason })` (CLI `clankie agents keep PANE --conversation ID`);
`keep: false` (or `clankie agents unkeep`) releases it and starts a new idle
period. A keep never closes anything and never stops your own `close_worker_pane`.

## Closing panes

Use `close_worker_pane` for each pane you judge finished, with a short one-line
reason and its saved report path when available. The service preserves its last
output and report in `worker_pane_history`, and returns an undo ID with a short
deadline. `undo_worker_pane` reopens and resumes that session. Abandoned fresh
hires, restored remote hires and the owner's roster routes have their own
guarded paths in [mechanics](reference/mechanics.md).

The service protects unsent drafts, owner-interactive or hand-started panes you
did not hire, results not kept, and unlanded work: `unlanded_work` names the
worker's dirty or unreadable worktree, or commits without a handoff. Clean
unlanded commits allow close when every commit is in a live merge-queue request,
reachable from a verified pushed remote ref, or covered by a `worth_landing` or
`safe_to_drop` decision at the current HEAD. Stale tracking refs and stale
decisions do not count, and `git cherry` skips merges, so unique merge
resolutions need the same handoff. Dirty files always refuse, even with a
decision or `unlandedReason`; pass `unlandedReason` only for a deliberate
decision about clean commits. Unknown draft state or provenance is a technical
failure: leave that pane alone and explain the gap. A missing Herdr session on a
reattached pane is not evidence that the worker is finished or that its results
are lost. Never bypass a refusal with raw pane-close or keystrokes, and never
retry a mutation automatically after an uncertain response.

Messaging or re-adopting a hand-started pane does not make it a hire. A legacy
record with lost provenance fails closed; do not infer a hire from its name,
report route or re-adoption.

## Worktrees

Inspect worktrees for the repositories covered by this tidy round with the
read-only `list_tidy_worktrees({ repository: REPO_PATH, mergedInto: "origin/main" })`
(omit `mergedInto` for its default, or use the deliverable's requested
destination). List the landed candidates with path, branch and destination
evidence (`landedBy: content` means every commit is on the destination by patch;
`decision` means a recorded safe_to_drop), and explain relevant exclusions. Main,
dirty, unlanded or live worktrees are excluded, and an unavailable or changing
census returns no candidates. Classify each retained unmerged or dirty tree as
landed by content, worth landing, or safe to drop, and record the last two with
`decide_tidy_worktree` and a one-line reason. Unlanded work is never removed
without one, and uncommitted files are never pruned. Even idle or shell panes
protect their working directories and worktrees nested below them. The list does
not establish ownership or refresh the destination ref: confirm your ownership
and current landing proof before removing a candidate.

Keep one owned linked worktree per deliverable, shared by its native slices and
reviews under distinct path ownership. After its result lands, preserve needed
reports and ignored evidence, verify destination merge and clean/inactive state,
then remove it with `prune_tidy_worktree` within the authorized owned cleanup
([mechanics](reference/mechanics.md#pruning-an-owned-worktree)). Keep another
owner's tree with that owner, and keep live workers' trees even when their pane
reports the main checkout as its cwd. Do not remove a tree just because its pane
closed or its last turn contained only a plan. Never treat a removal refusal as
permission to force it. A worker that acknowledged queued work still needs to
continue the authorized action or supply an actionable blocker.

Say what you closed and why in the conversation you are working in, and offer
the returned undo IDs and deadlines. Name any panes you left because of a
refusal or uncertainty, and the remaining worktree candidates. If the owner
stops the turn, stop tidying. Checkout sync and disk-pressure cache reclaim are
in [mechanics](reference/mechanics.md).
