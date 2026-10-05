# Manual project native proof integration

`project-native-proof.integration.test.ts` runs only on macOS with
`PROJECT_NATIVE_PROOF_TEST=1`. Build the checkout helper with
`pnpm fleet-proof:build`, then run:

```sh
PROJECT_NATIVE_PROOF_TEST=1 pnpm exec vitest run --config vitest.config.ts apps/clankie/test/project-native-proof.integration.test.ts
```

The fixture owns an isolated Herdr daemon, shell panes, ordinary foreground Node
processes and real TCP clients. Herdr CLI hooks provide actual pane metadata.
The service explicitly trusts the exact fixture executable/script through the
existing launcher seam. This exercises kernel executable, argv, process lifetime,
ancestry, Herdr and LocalFleetLink boundaries; it does **not** launch or prove an
installed Codex/Pi TUI. No provider account, model, or live fleet is involved.

Each refused HTTP request must leave the effect counter unchanged. Coverage
includes an unrelated background job in the same pane, a foreign pane, an
outsider, revoked binding, missing helper (no legacy fallback), an incorrect
script, a foreground shell, and a real live socket with a mismatched birth pin.
The original client and foreground process must reach kernel ESRCH before the
replacement process connects. The replacement has a different PID, kernel birth,
and socket; the previous birth cannot authorize it. This is a stale-lifetime
boundary test, not a claim that the operating system recycled a literal PID.

A copied trusted script containing spaces, Unicode, quotes and a newline proves
exact argv boundaries. `exec-argv.c` uses real execv to preserve empty argv[0]; it
must remain empty and the request must fail. Only the first two native argv
entries are returned; later argument and environment sentinels must be absent.
The helper owner's separate native probes cover empty argv[1], argc zero,
invalid UTF-8 and output bounds.

The spawn counter wraps the actual ChildProcess dispatch, preserving its original
implementation and recording the `spawn` event. It measures only the project
proof, excluding setup, metadata diagnostics and subsequent evidence snapshots.
There are no HTTP retries or timing thresholds. Tests restore the wrapper and
remove only their own daemon, sockets and processes. Evidence is written below
`.local/project-proof/`.

The counter also records active sibling proof children at each dispatch and waits
for their close events. The current proof separates project observations from
socket censuses: project → socket → private checks → socket → project. Both
checkpoint pairs must agree. The test asserts that neither socket census overlaps
another owned proof child, while every subsequent request still observes afresh.

For the before/after measurement, preserve the three original files from
`b5533700` into `.local/project-proof/baseline/`: `project-process-proof.ts`,
`local-fleet-proof.ts`, and `local-fleet-process.ts`, from `apps/clankie/src/`.
For example, from the checkout root:

```sh
mkdir -p .local/project-proof/baseline
for source in project-process-proof local-fleet-proof local-fleet-process; do
  git show "b5533700:apps/clankie/src/$source.ts" > ".local/project-proof/baseline/$source.ts"
done
```

Set `PROJECT_NATIVE_BASELINE=1` alongside the native flag. `baseline.ts` bundles
these unchanged inputs with dependencies resolved from the original source
directory. A successful baseline records actual counts; later runs assert fewer
spawns if this local baseline exists. The current path always asserts zero
`ps`/`lsof` proof dispatches. Baseline artifacts are local evidence, not new CI or
checked-in copies of production code.
