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
without waiting for the owner to list panes or approve each close
([ADR 0228](../../../docs/adr/0228-quick-actions-are-skills-and-tidy-keeps-results.md)).

Acknowledge a report only once you have its result; that is what lets the pane
go. The service also tidies on its own under the owner's `autoTidy` fleet setting
(default `1h`), through the same guards, and never closes a seat a project names
as its standing reviewer. Every observed lifecycle change restarts the full idle
window, including a short turn between five-minute sweeps. This requires Herdr
lifecycle counters. Recent reports (including acknowledged ones) and progress
also extend the window, even on older builds. Report text
does not automatically keep a seat waiting on the lead; use `keep_worker_pane`
when follow-up needs its live context. It closes only with positive work proof: a
kept report, every report acknowledged, and every unlanded commit landed on
advertised `origin/main`, covered by a retained current-HEAD decision, or parked
(below). Missing or non-Git working directories, dirty files and incomplete
observations hold the pane; never infer no work from an empty result. It adopts a
local hire whose start never confirmed only from the exact native session its
original receipt recorded. Your fleet round lists hires idle past the window that
it could not close, with each blocker: close them yourself, acknowledge their
reports, or keep them, rather than carrying them. Where the
owner turned automatic tidy off, leave it off until they decide otherwise
([ADR 0280](../../../docs/adr/0280-automatic-tidy-requires-positive-work-proof.md)).
When a worker's live context is worth keeping, or the owner asks, call
`keep_worker_pane({ pane, reason })` (CLI `clankie agents keep PANE --conversation ID`);
`keep: false` (or `clankie agents unkeep`) releases it and starts a new idle
period. A keep never closes anything and never stops your own `close_worker_pane`.
Keeps and unread reports outlive their seat only briefly: every five minutes the
service drops keeps whose pane and session its fleet no longer lists, and
retires unread reports from panes gone for over an hour, keeping their text in
`retired-worker-reports.jsonl` (VUH-2806). Release a gone pane's keep early by
its old pane id.

## Closing panes

A missing local checkout can be proved landed without fabricating a launch
baseline. The service binds the original native allocation to its controller
relocation, then checks the allocated branch against canonical GitHub PR and
main state. A surviving local ref must agree. This covers only that missing
checkout; other work, unknown provenance, changed refs, provider failures and
main checkpoints still hold. Worker text and `leave_unlanded` cannot supply
this proof. Verified evidence is retained in private close history and
`captain/landed-close-proofs.jsonl`; it never confirms a failed hire or repairs
native admission.

For a GitHub job with its own landed commits, close-out also needs main's post-merge checkpoint:
`landing`, `checkpoint` and `mac` must all complete green, or a repository
issue (open or closed) must name the red run URL or merge SHA. The merge is the
first main commit containing the worker's landed HEAD. A completed green run
on a descendant main commit covers it too. Cancelled runs provide no result;
running, missing or unreachable evidence holds the pane. `main_red`,
`main_pending` and `main_unknown` explain the hold, with the merge, run URL and
failing jobs when known. Repositories whose 20 recent main push runs have none
of those jobs have no checkpoint to wait for. A worker with no commits beyond
its recorded hire/worktree base (or Git fork point) is not charged with someone
else's main commit. A directory positively identified by Git as non-Git also has no merge to check unless the hire recorded a Git baseline. Missing or inaccessible directories remain unknown unless the exact missing-checkout provider proof above succeeds; other retirement guards still apply. CI and bug reads share a three-minute connection-scoped
cache, so retry after expiry when a bug was just filed. Unreadable or rate-limited
reads still hold. File and link the red-run bug, then retry; an
`unlandedReason` never overrides this hold. The same guard covers auto-tidy and
connector `close_agent`, and the fleet round carries its blocker. See
[ADR 0310](../../../docs/adr/0310-ci-is-a-checkpoint-not-a-wait.md).

Use `close_worker_pane` for each pane you judge finished, with a short one-line
reason and its saved report path when available. The service preserves its last
output and report in `worker_pane_history`, and returns an undo ID with a short
deadline. A successful close immediately tries the existing guarded prune for the
hire's exact local worktree. Only clean landed trees qualify (ancestry, content,
or `safe_to_drop`); shared panes/processes, main and managed runtimes stay.
The returned `entry.worktree` says `removed`, `kept`, or `unavailable`, with its
reason, evidence path and estimated `freedBytes`. Cleanup failure never fails
the close. An explicit unlanded reason leaves the tree even if it is landed.
`undo_worker_pane` reopens and resumes the session only while its directory still
exists; removal keeps the harvested session/output and evidence but prevents Undo. Abandoned fresh
hires, restored remote hires and the owner's roster routes have their own
guarded paths in [mechanics](reference/mechanics.md) ([ADR 0228](../../../docs/adr/0228-quick-actions-are-skills-and-tidy-keeps-results.md)).

The service protects unsent drafts, owner-interactive or hand-started panes you
did not hire, results not kept, and unlanded work: `unlanded_work` names the
worker's dirty or unreadable worktree, or commits without a handoff. Connector
`close_agent` refusals report each tree's state, reason and known dirty-file and
unlanded-commit counts; `unknown` is missing proof, not proof of unlanded commits. Clean
unlanded commits allow close when every commit is in a live merge-queue request,
reachable from a verified pushed remote ref, or covered by a `worth_landing` or
`safe_to_drop` decision at the current HEAD. Stale tracking refs and stale
decisions do not count, and `git cherry` skips merges, so unique merge
resolutions count as unlanded. Any clean commits left over are **parked**: the
close creates a local branch `keep/<deliverable>-<sha12>` (the worktree's branch
name, or the pane title when detached) at the worktree's HEAD, records its ref,
HEAD and commit SHAs as a `parked` handoff in the close receipt, issue comment
and lead notice, and closes. The worktree stays; the branch survives its removal.
Parking never moves an existing ref: a taken name refuses `unlanded_work`.
A worker that removed its own recorded worktree is judged by the branch the
host recorded at hire, read from the shared repository. No commits past the
hire's start, or all of them on `origin/main` by content, closes (main's
checkpoint still applies). Unlanded commits refuse with each one named, and a
deleted branch refuses as unknown.
Recover with `git log keep/...`; delete the branch once its work has landed or
is dropped. Dirty files always refuse, even with a decision or
`unlandedReason`; pass `unlandedReason` only for clean commits that could not be
parked. Unknown draft state or provenance is a technical
failure: leave that pane alone and explain the gap. A missing Herdr session on a
reattached pane is not evidence that the worker is finished or that its results
are lost. Never bypass a refusal with raw pane-close or keystrokes, and never
retry a mutation automatically after an uncertain response ([ADR 0280](../../../docs/adr/0280-automatic-tidy-requires-positive-work-proof.md)).

Messaging or re-adopting a hand-started pane does not make it a hire. A legacy
record with lost provenance fails closed; do not infer a hire from its name,
report route or re-adoption ([ADR 0321](../../../docs/adr/0321-the-roster-says-who-started-each-agent.md)).

## Worktrees

Inspect worktrees for the repositories covered by this tidy round with the
read-only `list_tidy_worktrees({ repository: REPO_PATH, mergedInto: "origin/main" })`
(omit `mergedInto` for its default, or use the deliverable's requested
destination). List the landed candidates with path, branch and destination
evidence (`landedBy: content` means every commit is on the destination by patch;
`decision` means a recorded safe_to_drop), and explain relevant exclusions. Main,
dirty, unlanded or live (`live_pane`, `live_process`) worktrees are excluded, and
an unavailable or changing pane or process census returns no candidates. Classify each retained unmerged or dirty tree as
landed by content, worth landing, or safe to drop, and record the last two with
`decide_tidy_worktree` and a one-line reason. Unlanded work is never removed
without one, and uncommitted files are never pruned. Even idle or shell panes
protect the worktree holding their cwd and worktrees nested below it, as does any
process working there. A cwd at `$HOME`, above it, or above the repository's main
checkout protects nothing below it on its own, so a seat at home no longer hides
every tree. A cwd at a worktree root (say `~/dev/clankie-wt`) still holds every
tree below it as `live_pane`; if every tree is held, look for a pane there
([ADR 0280](../../../docs/adr/0280-automatic-tidy-requires-positive-work-proof.md)). The list does
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
continue the authorized action or supply an actionable blocker ([ADR 0223](../../../docs/adr/0223-hires-use-repo-workspaces-and-pipeline-tabs.md)).

Say what you closed and why in the conversation you are working in, and offer
the returned undo IDs and deadlines. Name any panes you left because of a
refusal or uncertainty, and the remaining worktree candidates. If the owner
stops the turn, stop tidying. Checkout sync and disk-pressure cache reclaim are
in [mechanics](reference/mechanics.md).
