# VUH-1707 update canary verification

The focused canary suite passed 15 integration cases using actual child processes,
HTTP probes, CPU counters and private operation/hold storage. The remaining
update, policy and health suites passed 39 cases; the existing health-to-first-turn
smoke passed separately. Clankie, TUI and protocol typechecks, scoped lint,
formatting and diff validation passed. No full `pnpm check` ran.

## Focused checks

From the independently installed `bex/vuh-1707-update-canary` worktree:

```sh
pnpm exec vitest run --config vitest.config.ts apps/clankie/test/runtime-canary.integration.test.ts
pnpm exec vitest run --config vitest.config.ts apps/tui/test/runtime-update.test.ts apps/tui/test/runtime-updater.test.ts apps/tui/test/update-command.test.ts apps/clankie/test/runtime-update.test.ts apps/clankie/test/runtime-canary-policy.integration.test.ts apps/clankie/test/runtime-health.test.ts
pnpm exec vitest run --config vitest.config.ts apps/clankie/test/app-smoke.test.ts -t 'boots with a stub captain and answers health, a channel turn, and episode recall'
pnpm --filter @clankie/clankie typecheck
pnpm --filter @clankie/tui typecheck
pnpm --filter @clankie/protocol typecheck
```

Scoped `oxlint --deny-warnings` covered every changed TypeScript/JavaScript file;
`oxfmt --check` covered changed supported source, JSON and Markdown files.

The boundaries cover full-window passage and release of only the canary's hold;
CPU/latency/unavailable/stale/mismatched/gapped samples retaining holds; restart
recovery; prior healthy checkpoints; uncertain alert claims without replay;
ordinary pre-canary rollback cleanup; authenticated policy API and real CLI
partial updates; and refusal of unsupported targets before installation or
shutdown. Existing update tests use their pre-existing fixtures. The new policy
suite crosses real HTTP, native bearer admission, CLI fetch and durable storage.

## Actual composition-root runs

The manual harness boots the real `apps/clankie/src/index.ts`, Captain, updater,
file credential broker, `/health` and deploy registry. Each run owns a temporary
HOME/config/state, random port and one process. Herdr, browser, model turns,
Discord and provider credentials are absent. It stops only its own child and
removes its own temporary HOME. No owner runtime or AWS deployment is changed.

```sh
env -u NODE_PATH node --import ./apps/clankie/node_modules/tsx/dist/loader.mjs apps/clankie/scripts/runtime-canary-live-proof.ts --run
env -u NODE_PATH node --import ./apps/clankie/node_modules/tsx/dist/loader.mjs apps/clankie/scripts/runtime-canary-live-proof.ts --run --healthy --output .local/runtime-canary-healthy-proof.json
```

These are manual-only commands, outside normal CI/checks. Each preceding healthy
cutover and previous healthy checkpoint is seeded; the actual updater helper is
not executed. Observation is accelerated to 30 seconds at one-second sampling,
with the unchanged 10% process-CPU and 250 ms health-p95 budgets. The default
five-minute observation was not exercised. Receipt source hashes identify the
working-tree input; the base HEAD alone does not identify uncommitted changes.

| Retained receipt                                                      | CPU mean | Health p95 | Observed result                                                                                                      |
| --------------------------------------------------------------------- | -------: | ---------: | -------------------------------------------------------------------------------------------------------------------- |
| [CPU burn](cpu-burn.json)                                             |   39.05% |  102.46 ms | CPU failure; cutover stays healthy, hold retained, next update HTTP 409 with no helper, previous checkpoint retained |
| [Initial healthy mode](healthy-startup-latency-failure.json)          |    1.43% |  448.16 ms | Latency failure; healthy passage unproven                                                                            |
| [Confirmed readiness](healthy-readiness-latency-failure.json)         |    1.33% |  437.21 ms | Latency failure after five seconds of actual health warmup                                                           |
| [Immutable boot identity](healthy-boot-identity-latency-failure.json) |    0.73% |  493.02 ms | Latency failure; both canary and unrelated owner hold retained                                                       |

The last run observes native Undici and Node HTTP diagnostic channels without
replacing requests or handlers. Two slow samples spent approximately 492 ms
before the server's request-start event; handlers took 0.31–0.52 ms. This locates
the observed wait before server receipt but does not establish its cause.
Publishing immutable boot identity removed unnecessary transaction-file reads
from `/health`; it did not establish a latency fix. No causal CPU improvement
is claimed. Budgets were not raised to obtain passage. The three healthy-mode
runs remain failed manual checks, preserved as negative evidence.

Committed receipts omit unrelated host power/process details and temporary paths.
Full raw receipts/logs remain ignored in `.local/`. CPU burn and healthy probes
ran before the final alert-state wording changed from `delivered` to `submitted`;
the focused integration suite verified the final wording and unchanged hold logic.

## Integration and remaining proof

The native alert hook is Oren's `notifyRuntimeHealthAlert(text): Promise<boolean>`
in `feat/vuh-1703-1704-fleet-health` (`400ddd70e776a8236b3e6fc58eb6346cfd6ed1fb`).
True means the path accepted the attempt, including a potentially unconfirmed
native send; `submitted` never claims a confirmed receipt. The isolated base did
not include that hook, so the CPU proof honestly records `unavailable`.

Remaining proof: a healthy full-service pass at the default budgets/window,
the observed pre-request latency cause, actual helper-to-service cutover, and
confirmed native alert receipt after Oren's integration. Native peer delivery was
unavailable, so alignment with Oren's VUH-1702 sampler must be confirmed by the
integrator. Local and managed consumers use process CPU with 100% meaning one
core, rather than the unrelated load-average-based body resource field.
