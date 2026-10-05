# Real native helper transport and recovery fixtures

`fixture.mjs` is an actual executable child speaking the production helper's
private JSONL protocol. The transport integration checks malformed replies,
close fencing, cancellation, timeout and explicit restart without mocking spawn
or pipes. `close-driver.mjs` runs separately so test-runner timers cannot conceal
an unsettled top-level await when closing an idle helper.

`codex-recovery-fixture.mjs` is an ordinary Node Unix WebSocket server and
foreground process. The manual recovery test copies the installed Node executable
unchanged to a private path named `codex`; this tests kernel executable/argv,
Herdr, native lifetime, Unix listener ownership and durable recovery boundaries.
It does **not** run or validate the installed Codex TUI, models or credentials.
Only a fresh owned Herdr namespace and its ordinary processes are created.

Run the cheap real-pipe cases normally:

```sh
pnpm exec vitest run --config vitest.config.ts apps/clankie/test/native-process-transport.integration.test.ts
```

The real macOS native-birth and Herdr recovery cases are manual only, after
building the checkout's native helper:

```sh
pnpm fleet-proof:build
FLEET_PROOF_NATIVE_TEST=1 pnpm exec vitest run --config vitest.config.ts apps/clankie/test/native-process-transport.integration.test.ts apps/clankie/test/herdr-codex-native-recovery.integration.test.ts
```

The recovery test retains each run's native/RPC observations in ignored
`.local/project-proof/native-recovery-*/`. It checks microsecond and legacy
receipts, live stale birth, changed loaded thread, two actual foreground
processes, restored uniqueness and durable revocation. Actual body spawn
instrumentation proves warm recovery creates no `ps`, `lsof`, Herdr CLI or
helper subprocesses. These manual checks are not a push/PR CI gate.
