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
invalidates the existing close authority. The proof calls no pane-close route.

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
