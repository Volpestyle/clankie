# Codex account headroom — VUH-1476

[Issue](https://linear.app/vuhlp/issue/VUH-1476/let-hires-choose-among-the-owners-codex-accounts-by-headroom).
Implementation and automated verification on 2026-09-30. No service restart,
login, push, or live account registration was performed. No real `auth.json`
contents were read. Authentication and hook trust remain owner steps.

## Behavior

```sh
clankie accounts codex add ~/.codex-jamescvolpe --label jamescvolpe
clankie accounts codex list
```

The same arguments work under `/accounts codex` in the TUI. Owner-authorized
GET/POST `/v1/accounts/codex` exposes registration and quota metadata. Settings
store canonical paths and labels only. `default` is implicit from `CODEX_HOME`
or `~/.codex`; removing a registration does not remove files.

Hires query Codex’s read-only `account/rateLimits/read` per registered home and
choose the greatest minimum remaining percentage across reported windows,
including weekly-only plans. The quota request starts no login or model turn.
If unavailable within ten seconds, recent rollout observations are the fallback.
Recent means no more than 24 hours old; expired resets replenish their window. Known positive headroom ranks before unknown, then exhausted; registry
order breaks ties. Homes without credential-file presence are skipped.
`account: "LABEL"` pins a registered account. Codex remains responsible for
validating authentication and enforcing quota. This is observed usage, not a
reservation: simultaneous hires can choose the same account.

The selected home feeds the existing skills overlay and app-server launch.
Session-id lookup searches registered homes; agent discovery/resume and queue
follow-ups use the matching home. Seat-sync already uses the hook's actual
transcript path. Roster account metadata survives refresh and restart; a new
occupant cannot inherit the previous account. The app shows only the label.

```sh
node scripts/evals/codex.mjs --account jamescvolpe --cases memory-card --reps 1 --max-runs 1
```

The Codex eval entry point reuses the existing runner and guard, selects one
account per whole campaign, and records the label/home in report options. It
refuses an initial guard stop/wait before loading credentials and never rotates
after a stop. Its dry-run and tests below do not load credentials. Big sweeps
belong on an API key with an explicit spend budget.

## Evidence

[Focused test output](focused-tests.txt), [eval dry-run](eval-dry-run.json),
[eval guard tests](eval-tests.txt), and [full-check blocker](check-blocked.txt) retain the decisive output.

Automated account, quota and launch tests use synthetic temporary homes and fake
worker processes. The additional live quota check below uses both supplied homes
without starting a model turn.

| Check                                                                 | Result                                                                                                                                                                                                                       |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Final focused suite                                                   | 11 files, 113 tests passed: registry, owner API/CLI, selector, actual hire tool with fake Herdr, account override, overlay link target, roster refresh/persistence, resume/queue, adapter, seat-sync, eval guard and pinning |
| Full harness Vitest run before the final integration tests were added | 382 files passed; 3,239 passed, 2 skipped; final changed behavior additionally covered by the focused suite                                                                                                                  |
| Harness typecheck                                                     | 27 tasks passed                                                                                                                                                                                                              |
| Harness lint, docs, infrastructure                                    | Passed                                                                                                                                                                                                                       |
| Vox tests and IPC smoke                                               | Passed                                                                                                                                                                                                                       |
| Harness `pnpm check`                                                  | Run twice; blocked at formatting by the other worker's `scripts/evals/isolation.mjs` and `scripts/evals/run.mjs` changes                                                                                                     |
| Separate dead-code check                                              | Only the other worker's unfinished `seat-cases.mjs`, `seat-service.mjs`, `seat.mjs` entries flagged                                                                                                                          |
| App `pnpm check`                                                      | Passed; Messages model/adaptive tests also passed (68 tests)                                                                                                                                                                 |
| Codex eval dry-run                                                    | Passed; fixture matrix and selected label only, no auth or worker launch                                                                                                                                                     |

The app label change is committed on app `main` as `30c2332`. Device rendering
was not re-tested for this metadata-text addition; existing adaptive iPhone/iPad
layout tests passed. Deployment is held for the lead.

## Live account follow-up

At 2026-09-30 15:59 UTC, the native quota API returned the opposite home ordering
from the reported 91% default-account usage:

| Home                                   | Weekly usage | Headroom |
| -------------------------------------- | -----------: | -------: |
| `~/.codex` (`default`)                 |           2% |      98% |
| `~/.codex-jamescvolpe` (`jamescvolpe`) |          92% |       8% |

Both returned a single weekly window. The second home had no saved rollout.
This exposed two gaps in the initial implementation: requiring two windows and
using saved rollouts alone. The follow-up queries live quota first and treats
one valid reported window as sufficient. Account identity was not inspected;
these results describe the credentials Codex used under each explicit home.

The actual updated selector chose `default`; an explicit override chose
`jamescvolpe`. [Sanitized live output](live-selection.json) includes only quota,
labels, and observation times. No credentials, account identity, credits,
transcript messages, or model output are retained. No real `auth.json` contents
were read by the verifier, no login command was run, and no service was restarted.
Codex itself handles authentication for the quota RPC. Registration was not changed.

[Follow-up focused tests](live-tests.txt): 76 tests passed, including reversed
weekly-only account ordering, no-rollout status, explicit overrides, RPC cleanup
and timeout, unavailable-query fallback, reset recovery, API quota, and the eval
guard rejecting live 92% usage over a lower saved sample. Typecheck (27 tasks),
changed-file lint, and docs checks passed. The broader run passed 382 files
(3,246 tests, two skipped) and exposed two fixture problems: a missing mock import
and a receipt test using the real default home under fake timers. Both were
fixed; the final rerun of those two files passed all 15 tests. The final focused
and hire runs therefore cover 91 passing tests. The full suite was not repeated
after those fixture-only fixes. `pnpm check` was rerun and remains
blocked by the other worker’s `scripts/evals/isolation.mjs` and
`scripts/evals/seat-cases.mjs` formatting;
[output](live-check-blocked.txt). The separate dead-code check still reports only
the other worker’s three unfinished seat-eval entry files.

The instruction worker's `43e3a994` commit included the shared `docs/cli.md`
account documentation while it was being edited. The implementation commit
retains that documentation and updates `docs/evals.md` to the isolated Codex
entry point, avoiding edits to the active eval worker's runner files.

Commit verification caught concurrent seat-suite documentation in `docs/evals.md`.
A corrective follow-up leaves that text intact in the working tree and outside
the account-selection changes at HEAD, ready for its owner to commit.
