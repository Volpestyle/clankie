# VUH-2802: auto-tidy leaves finished workers open

Tracks: https://linear.app/vuhlp/issue/VUH-2802

## Root cause of the unconfirmed Claude starts

`herdr agent start` waits for the named agent to become ready. Its loop keeps waiting
while the agent is `working` and succeeds only at `idle`/`done` with `interactive_ready`
(`~/dev/herdr/src/cli/agent.rs`, `wait_for_named_agent`). Since VUH-2499, a fresh Claude
hire takes its brief as the native startup prompt, so its first turn can already be running
when Herdr's settle delay ends. Herdr then never sees idle within its 30 s wait and
returns `{"code":"timeout","message":"timed out waiting for agent startup"}`. The Claude
adapter treated every launcher error as unconfirmed, even after it had bound the session
and the brief was in the transcript. Codex hires take their brief over the app server after
startup, so Herdr sees them idle first.

In the service log, 56 of the 59 recent local Claude `start_unconfirmed` hires carry exactly
this error, and local Claude hires went from mostly `spawned` to almost always failing
right after VUH-2499 landed (`production-hire-outcomes.txt` in the captures).

Whether a given start hits the timeout depends on how Herdr reads Claude's screen during
startup. In three unforced real runs it did not: Herdr 0.9.3 resolved at 8.1 s twice, and the
service's Herdr 0.9.1 resolved at 21.5 s. So the native before/after proof forces Herdr's own
typed timeout with a 4 s `--timeout`.

```mermaid
sequenceDiagram
  participant A as Claude adapter
  participant H as herdr agent start
  participant C as Claude TUI
  A->>H: start with the brief as the startup prompt
  H->>C: launch
  C->>C: first turn begins (working)
  H-->>A: typed timeout: never saw idle
  A->>A: bind the observed session
  alt typed Herdr timeout on a fresh brief
    A->>C: read the exact brief attachment in the native transcript
    C-->>A: present: started (absent: brief_delivery_unverified)
  else any other launcher error
    A-->>A: start_unconfirmed, as before
  end
```

## Proof

- **Claude start, real TUI.** The source adapter in disposable live-Herdr panes, with
  the service's Herdr 0.9.1, high effort and the worker skills plugin directory, a
  first turn of `sleep 45`, and a forced 4 s readiness wait. The old adapter returns
  `Claude startup is unconfirmed: Error: {"error":{"code":"timeout",…}}`, the exact
  production failure, while the turn completes. The fixed adapter returns `started`, with
  one native prompt and no channel send. Captures: `before-forced-timeout/`,
  `after-forced-timeout/`. Unforced runs (`run/`, `prod-like/`, `svc-herdr/`) started
  normally.
- **Auto-tidy, real Herdr and Claude.** `apps/clankie/test/auto-tidy-unconfirmed-native.integration.test.ts`
  (manual: `AUTO_TIDY_UNCONFIRMED_NATIVE_TEST=1`, `CLAUDE_NATIVE_CONFIG_DIR` for a
  non-default profile). It runs an idle real Claude TUI (no prompt, worker plugin disabled)
  in an isolated Herdr, with real process proof and draft detection, and closes the
  native pane. It restores the live Juniper journals from just before their manual
  adopt (`fixtures/hire-receipts/local-unconfirmed-claude-start.json`). An unread report
  holds the pane, and the lead-round text names it with `acknowledge_worker_reports`. A
  receipt that never recorded its session is not adopted, and the close refuses
  `provenance_unknown`. Once the receipt records the observed session, the next sweep
  adopts it, settles the receipt `adopted`, confirms the allocation and closes the pane.
  Results: `auto-tidy/results.json`.
- **Retirement fence (review).** Sage found that adoption confirmed the allocation
  before it saved the receipt settlement, so a failed save released the retirement
  barrier for good. Now the settlement is durable first. `retirementGuard` also refuses
  any unsettled original for the pane's occupant, even with a confirmed allocation or an
  unreadable journal, and auto-tidy holds (`adoption_refused`) when adoption refuses.
  `auto-tidy-adoption-fence.integration.test.ts` forces the journal's rename to fail.
  The fence holds immediately and after a restart, auto-tidy does not close, and later
  adoption settles and releases it. A confirmed allocation with an unsettled original
  stays fenced until operator adopt. Both tests fail on the first candidate, and Sage's
  own probe passes.
- **Regression.** `claude-hire-startup.integration.test.ts` adds the typed-timeout cases,
  with the prompt recorded (started) and not recorded (unverified). Both fail on the old
  adapter.

## Parking clean unlanded work (part d)

A finished hire whose worktree holds clean commits that nothing hands off (no
`origin/main` landing, merge-queue request, pushed ref or current-HEAD decision) no longer
holds its close. `close_worker_pane` and auto-tidy park those commits on a new local
branch, `refs/heads/keep/<deliverable>-<sha12>` (the worktree's branch name, or the pane
title when detached), and record a `parked` handoff with the ref, HEAD and commit SHAs in
the close receipt. The same refs go into the lead's auto-tidy notice, the seat issue
comment and a `closed_unreconciled` worktree decision, and then the pane closes. This
replaces the lead's manual `git branch -f keep/...` plus `unlandedReason`.

```mermaid
flowchart TD
  A[close or auto-tidy sweep] --> B{worktree readable, clean, has HEAD?}
  B -- no: dirty / unknown / remote --> R[refuse unlanded_work]
  B -- yes --> C[cover commits: main, merge queue, pushed ref*, decision]
  C --> D{commits left?}
  D -- no --> G[close guards]
  D -- yes --> P[plan keep/&lt;deliverable&gt;-&lt;sha12&gt;]
  P --> G
  G --> S[save closing record]
  S --> F[final guard: create ref only if absent or already at HEAD]
  F -- name taken at another commit --> R
  F -- ok --> X[native close; receipt records parked ref + SHAs]
```

\* Pushed refs count for a manual close only; auto-tidy counts advertised `origin/main`.

The ref is created only in the final close guard, after the closing record is saved, so a
close refused before then (draft, provenance, report, dirty work) parks nothing. A keep or
lost authority that arrives within that final guard can still refuse after the ref exists;
the ref then only preserves the commits. Parking never moves an existing ref.
Dirty, unreadable, remote and missing work directories still refuse, as before.

- **Native, real Herdr and Claude.** `apps/clankie/test/auto-tidy-parking-native.integration.test.ts`
  (manual: `AUTO_TIDY_PARKING_NATIVE_TEST=1`, `CLAUDE_NATIVE_CONFIG_DIR`). It runs two idle
  real Claude TUIs (no prompt, Clankie plugins disabled, `DISABLE_AUTOUPDATER=1`, real XDG
  directories, launcher asserted unchanged) in an isolated Herdr, with disposable
  worktrees of a fixture repository. Each TUI runs in this trusted checkout, and the tidy
  reads its fixture worktree through the production Git reconciliation. Results, run
  with `CLAUDE_NATIVE_CONFIG_DIR=~/.claude-james` (`parking/results.json`):
  - `close_worker_pane` path with a dirty detached worktree: refuses `unlanded_work`, with
    and without `unlandedReason`. No ref is created and the pane stays.
  - Two clean, unreferenced detached commits: closed, `parked` on
    `keep/claude-code-6c15ade12fbb` with both SHAs, and the native pane is gone.
  - Auto-tidy with a dirty branch worktree: held `unlanded_work` past the window. The lead
    round names the next step.
  - Auto-tidy when someone else's ref already holds the park name: held, and that ref is
    unchanged.
  - Auto-tidy, clean: closed, `parked` on `keep/vuh-2802-spike-821ba41cc110`. The lead
    notice lists it, and a `closed_unreconciled` decision is recorded.
  - Both worktrees removed, the worker branch deleted, every reflog expired and
    `gc --prune=now`: both parked stacks still read back.
- **Old-source regression.** The same native test against the pre-change source fails at
  the clean manual close (`parking/results-old-source.json`). Four
  `pane-tidy.integration.test.ts` cases fail on the old source: detached work, a pushed
  feature branch, partial pushes and a unique merge resolution. All now park. A fifth,
  rewritten case keeps the old explicit `unlandedReason` path for clean commits that
  cannot be parked.

Not changed: the operator `close_seat` route (TUI and app) keeps its existing
`unlandedReason` hold. A rollback to a build before this change cannot parse close
history that holds a `parked` handoff.

## Limits

- The lead-round text is checked in the native test. A live 30-minute round was not observed.
- Parking (the third criterion) is proven in an isolated Herdr, not yet on the live fleet
  over a real idle window. The service must restart onto this code first.
- During development, one native run let the isolated Herdr's `XDG_DATA_HOME` reach
  Claude. Its installer repointed `~/.local/bin/claude` into the temporary directory for
  about a minute (01:40–01:41Z) until it was restored. The test now strips those
  variables, disables the updater and asserts that the launcher is unchanged.

[Captures: native driver, results, transcripts, production outcome summary](captures.tar)
