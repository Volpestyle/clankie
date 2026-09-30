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

Hires choose the greatest minimum remaining percentage across both rollout
windows. Recent means no more than 24 hours old; expired resets replenish their
window. Known positive headroom ranks before unknown, then exhausted; registry
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

All account, quota and launch tests use synthetic temporary homes and fake
worker processes; they do not spend either live subscription.

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

A read-only metadata check of the supplied second home returned
`{ "authPresent": true, "headroom": null, "observedAt": null }`.
This proves credential-file presence only. It does not validate the login;
there is no recorded usage sample yet. Pin that label explicitly for its first
hire if another account has known positive headroom.

The instruction worker's `43e3a994` commit included the shared `docs/cli.md`
account documentation while it was being edited. The implementation commit
retains that documentation and updates `docs/evals.md` to the isolated Codex
entry point, avoiding edits to the active eval worker's runner files.
