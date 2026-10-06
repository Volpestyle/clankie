# Landing queue evidence — VUH-1761

Candidate on `rowan/vuh-1761`, based on `origin/main` at `47cbe333`.
The [issue](https://linear.app/vuhlp/issue/VUH-1761) links the exact candidate
commit. The lead owns landing and closure.

[Final check output](evidence/final-checks.log): **49 tests passed** across the
integration, main push guard, headless launcher and install doctor files.
Scoped lint, sequential typechecks for `@clankie/protocol`, `@clankie/clankie`
and `@clankie/tui`, local doc links, retired claims and public docs checks passed.
All installs, builds, test runs and typechecks ran through `clankie heavy --`.

| Boundary                                                                      | Observed result                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real HTTP CLI/API queue, local bare Git origins and real pnpm gates           | One gate running with three waiting requests; those three share the next batch. Two healthy requests land, one conflict is reported. Two core gates total, including the initial gate.                                                         |
| Core/app request conflict                                                     | Its applied core commit rolls back when app conflicts; the paired core file is absent from the landed tree.                                                                                                                                    |
| Failed shared gate                                                            | Two healthy requests land; the bad request fails with exit 9 and three retained attempts. Six core gates including the initial gate and diagnostic subsets.                                                                                    |
| Queue status and durable receipts                                             | Running, waiting and last result are visible. Original IDs remain idempotent, changed input is refused, reloaded finished receipts retain their result, lost active work reports interrupted.                                                  |
| Real launcher doctor installation in disposable clankie and clankie-app repos | Guards block `main`, `HEAD:main`, full remote main ref and deletion. Branch pushes work; linked worktrees share the guard. Explicit owner bypass requires a reason and records an audit.                                                       |
| Hooks and landing                                                             | Existing hooks are preserved; disabled and non-executable guards are diagnosed. Guarded source repos still integrate through hook-disabled clones. Existing server rejection/partial landing, holds, HEAD purity and origin drift checks pass. |

The [first run](evidence/first-run.log) had two failures: Git cannot resolve an
effective hook path below `/dev/null`, and the API client throws on HTTP 409.
Doctor now reports that disabled path as a conflict; the request identity test
expects the actual client exception. Both pass in the final run.

[Read-only inspection](evidence/live-guard-offer.jsonl) of both live source checkouts returned `offered`, with no
hook conflict. **The guard is ready to install. Live hooks remain uninstalled;
installation on this Mac requires James's approval.**

The full repository gate and live service activation belong to the landing
step. No evals ran. TUI queue output compiles and is included in the generated
console reference; interactive TUI rendering was not exercised.

Reproduce the focused test evidence:

```bash
clankie heavy -- pnpm exec vitest run \
  apps/clankie/test/integrate.integration.test.ts \
  apps/tui/test/main-push-guard.integration.test.ts \
  apps/tui/test/headless-captain.test.ts \
  apps/tui/test/install-doctor.test.ts --reporter=verbose
```
