# VUH-2938: short turns renew auto-tidy's idle window

The old baseline survives a complete turn between five-minute tidy sweeps.
The roster's `pane list` omits lifecycle counters; `agent get` supplies them.
The service now preserves those counters and reads a fresh candidate before
timing it. A counter change starts a full window at observation. Exact-occupant
reports (including acknowledged reports) and progress extend the window.
The close authority rechecks activity after asynchronous checks.

## Reproduction and verification

`apps/clankie/test/auto-tidy-short-turn.integration.test.ts` starts a real
Herdr server with scratch HOME and every XDG root confined to its temporary
directory. It refuses restored workspaces. A compiled foreground fixture
process named `claude` emits native terminal titles; Herdr recognizes its
working and settled states. The production runner parses the real CLI replies.
No coding harness or model is launched.

Only the idle clock is accelerated. A real completed turn, observed by Herdr,
fits entirely between tidy sweeps and takes less than the 300,000 ms poll
interval. The seat remains ineligible at the old expiry and until the renewed
window. A later acknowledged report extends the window again. At expiry the
close seam records one eligible attempt; a report arriving during close checks
invalidates the existing close authority. It then restores that old report time,
proves the authority is valid again, runs another real short turn without changing
the report time, and verifies the close authority refuses. The proof calls no
pane-close route.

- Original `auto-tidy.ts` from `616e0345990e`, with the new parser and regression:
  **failed** at the old expiry: expected no close attempt, received `w1:p1`.
- Fixed timing code: **passed**, one real-process regression (about five seconds).
- Existing pane-tidy and reviewer integration checks: **73 passed**.
- Service and test typecheck: **passed**, including all 16 test partitions.
- Dependencies installed in this worktree with the frozen lockfile.

Commands ran through `clankie heavy --`:

```sh
pnpm exec vitest run apps/clankie/test/auto-tidy-short-turn.integration.test.ts
pnpm exec vitest run apps/clankie/test/auto-tidy-reviewer.integration.test.ts apps/clankie/test/pane-tidy.integration.test.ts
pnpm --filter @clankie/clankie typecheck
```

The owner's auto-tidy setting was read as `1h` and was never changed.
Waiting-on-lead report wording does not create an automatic keep: heuristics
would guess at intent. The lead can use `keep_worker_pane` for follow-up context.
The lead owns issue closure after landing and evidence review.

## Review guard proof

The revised regression passes with the complete guard. Mutation X4 removes only
the comparison of fresh completion/state-change counters in `authorize`: the
test then fails at the final `authorizeClose()` assertion (expected false,
received true). The comparison was restored afterward.

The new per-pane `agent get` runs only inside auto-tidy's pane sweep/close
authority. The disk-reclamation and HOME-pane cache fixtures do not invoke that
flow: prune/cache operations accept only `Pick<HerdrWatchRunner, "list">` and
call `tidyPaneDirectories`. The disk fixture throws on any native command other
than `pane list`. Their imported runner's list implementation is unchanged.
This rules out those new reads in their execution paths; it does not establish
why the shared-volume free-space assertion or scratch-directory cleanup failed
in the first landing run. A fresh gate must pass both on its first attempt.
