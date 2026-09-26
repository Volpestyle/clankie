# Pi hire readiness — VUH-1373

The real native acceptance run passed **20 consecutive hires, 0 `not_ready`,
20 completed pi turns, in 64.781 seconds**. Herdr 0.9.1 and pi 0.87.1 ran in an
isolated named session; the model response was a local canned SSE stream.
This validates the actual `HerdrWatchStore.spawnSeat` → CLI → pi integration →
session report → send-input → pi transcript path. It is not a new Docker build
or a full `hosted:smoke` run.

## Cause and fix

The original hosted failure was `not_ready` with an empty-stderr
`Command failed: herdr agent start ...` detail. The runner gave startup the same
5-second process deadline as a short query, although Herdr's native startup
readiness deadline is 30 seconds. Under CPU contention this kills the CLI before
pi reports readiness, and the failure path then closes the worker's pane.

The diagnosis preserved the same pi process after the CLI failed and observed
its session report afterward:

| Existing Linux image / CPU limit | Starts | CLI failures | CLI elapsed            | Session observed                |
| -------------------------------- | -----: | -----------: | ---------------------- | ------------------------------- |
| Unconstrained                    |      8 |            0 | 3.010–3.109 s          | 3.012–3.111 s                   |
| 0.5 CPU                          |      8 |            0 | 3.010–3.115 s          | 3.014–3.117 s                   |
| 0.1 CPU                          |      8 |            8 | 5.002–5.101 s, SIGTERM | 13.198–16.409 s, idle + session |

All eight constrained failures had `killed: true`, `signal: SIGTERM`, empty
stderr, and the same error shape as the original smoke. This directly supports
the timeout diagnosis; the original smoke did not retain a timed process trace,
so this does not prove every historical failure had that cause.

Startup now passes Herdr an explicit 30-second readiness timeout and a
35-second process watchdog, leaving ordinary queries at 5 seconds. The existing
bounded 10-second session-report poll remains required. Native startup failure,
watchdog failure, or missing session returns the existing typed
`failed` / `not_ready` result and closes only the hire's pane. No retry is added.

Pi's installed integration reports `pane.report_agent_session` from its
`session_start` callback. The report includes a durable session path before the
transcript is created; file existence is not readiness. Baseline JSONL records
show this explicitly (`sessionFileExists: false` with an idle pi and session).

## Evidence

- [Historical failure excerpt](logs/historical-failure.txt).
- [Unconstrained baseline](logs/baseline.jsonl), [0.5 CPU baseline](logs/loaded-before.jsonl),
  [0.1 CPU baseline](logs/throttled-before.jsonl), and [diagnosis source](flows/diagnose.md).
- [Fake-Herdr red](logs/red.txt): delayed 5.5-second startup fails before the fix
  (1 failed, 2 passed). [Green](logs/green.txt): 64 tests pass across startup,
  watch, hire-brief and optional-Herdr suites, including the added ordinary-query
  timeout test. The delayed test uses a real child process implementing fake Herdr.
- [Native acceptance](logs/native-acceptance.jsonl): 20 sequential hires without
  retries, final wall time and versions. [Pi assistant messages](logs/native-pi-turns.jsonl)
  independently verify all 20 actual completed responses; [Herdr log](logs/native-herdr-server.txt)
  captures creation, process detection, input and closure.
- [Linux stress acceptance, interrupted](logs/linux-acceptance-interrupted.jsonl):
  first 9 consecutive hires pass at 0.1 CPU, startup 11.501–14.406 seconds. At
  approximately 20:04Z Docker stopped responding; `docker ps` hung and `docker cp`
  returned HTTP 500. This is **not** a completed 20-run Linux gate. The separate
  native 20-run gate above completed after that interruption.
- [Docs check](logs/docs-check.txt) passes (382 local Markdown files and public docs).
- [Package typecheck](logs/typecheck.txt) passes. Scoped TypeScript checking of
  the changed source and regression test also passes.
- [Full check](logs/check-final.txt) stops at unrelated formatting in
  `apps/tui/src/face/clankie-autocomplete.ts`,
  `docs/testing/2026-09-26-interactive-swarm-workers/startup-incident.md`, and
  `packages/model-provider/src/pi.ts`. Those shared files were not changed here.

Focused test command:

```sh
pnpm exec vitest run apps/clankie/test/herdr-startup.test.ts apps/clankie/test/herdr-watch.test.ts apps/clankie/test/hire-brief.test.ts apps/clankie/test/herdr-optional.test.ts
pnpm --filter @clankie/clankie typecheck
pnpm_config_verify_deps_before_run=false pnpm check
```

## Reproduction and isolation

[Acceptance source](flows/prove.md) is archived as Markdown so it does not create
an unused application entry point. Extract its fenced source to `flows/prove.mjs`
for the relative import, or replace the import with the absolute checkout path
when storing scratch code outside the repo. Bundle with:

```sh
pnpm exec esbuild /tmp/prove-source.mjs --bundle --platform=node --format=esm \
  --banner:js='import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' \
  --outfile=/tmp/prove.mjs
```

The Linux run reused image
`sha256:f5729c6c0673097668c0a85ccdd505ce313e2cc9d40c55b3750758d739df93b8`
(`clankie-hosted:local`), with Herdr 0.9.1 / pi 0.84.2 and `--network none`,
no mounts or host credentials. Docker was inspected before use; **no image was
built**. The image's identical Herdr binary was copied within the container to
an executable path for its node user (SHA-256
`f4ccf4de745f2cb9a39a983e9ba3703dad50ec2a58dea83026ceab721bbd8d9e`).
The pre-fix runner and fixed harness were bundled from checkout source and copied
into that container; the image alone does not contain the fix.

[Native setup](flows/native.md) records the fallback environment and adaptations.
It uses separate configuration, pi data, working directory and named Herdr socket.
Only its own panes and server were stopped. [Docker cleanup](logs/docker-cleanup.txt) could not complete
while the shared backend was unavailable; the owned container is
`vuh1373-pi-readiness`. Do not restart shared Docker merely for this cleanup.
No push, deployment, production calls, or `hosted-body.ts` edits were performed.
