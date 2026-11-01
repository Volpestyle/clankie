---
name: fleet-resources
description: "Run heavy commands and lease simulators in Clankie's local native fleet. Use for builds, typechecks, test suites, installs and owned runtime instances, or when inspecting a resource wait."
---

# Share the machine

Every agent on this machine shares one service-owned resource registry. The
rules that matter on most turns:

1. Run builds, typechecks, test suites, installs and owned runtimes through
   `clankie heavy --`. Keep the whole runtime and its children inside the
   wrapper's lifetime.
2. Name files, not directories or globs, and don't wrap a focused check in
   `sh -c`; either turns it into a full job.
3. Dev servers and long-lived services use the server lane. Never launch one
   ungoverned, and stop it when you are done.
4. Boot simulators only through `clankie simulator acquire`, verify the lease
   before driving the device and release it after. Verified native activity or
   exact-holder heavy work retains supported holders without timer touches.
5. A wait is the governor working. Never bypass it with another registry,
   launch route or `HOME`, and never stop a job you can't prove is yours.
   Never stop processes by pattern (`pkill -f`, `killall`) on a shared
   machine: every seat runs as the same user, so a pattern kills other seats'
   gates. Stop your own job by its PID or process group.
6. Search with `rg`, or with `find` from a narrow directory and a `-maxdepth`.
7. Wait outside your turn. Run a long heavy command, gate or integration wait
   as your harness's background task and continue on its completion notice;
   never loop on `sleep` in the foreground to poll a log or a status. Each
   foreground step re-reads your whole context.
8. Write shell commands Claude Code can parse safely. Before running one it
   can't, such as an unguarded `rm -rf $VAR/*` or a zsh-only expansion like
   `${(f)"$(cat f)"}`, it asks the owner, never the lead. In a hired seat
   nobody answers, and the command is denied after about two minutes. Use
   `"${VAR:?}"`, literal paths, plain file lists or `xargs`.

```sh
clankie heavy -- pnpm --workspace-concurrency=1 --filter @clankie/clankie typecheck
clankie heavy -- pnpm exec vitest run path/to/relevant.integration.test.ts
clankie heavy -- node path/to/owned-runtime.js
clankie heavy --server -- node path/to/owned-service.js
```

## Lanes

`clankie heavy` sizes the command for you. Focused checks run in the **light
lane** (two cores, own slots, gated only by memory) and start beside full jobs:
Vitest naming up to eight test files, `tsc` without `--build`,
`pnpm --filter ONE typecheck`, and Oxfmt/Oxlint (including this repo's
file-aware `pnpm fmt`, `pnpm fmt:check` and `pnpm lint`) naming up to 64
existing files. Whole-repository scripts, directories, globs, missing files,
unknown flags and type-aware linting are **full** jobs.

The **server lane** has its own slots and CPU budget, so it never takes
build/check slots. Expo start, `pnpm dev`, Vite/Next dev and recognized watch
commands select it automatically; say `--server` for a custom script or a
shell-wrapped service. Keep children in the owned process group;
detached or privileged processes are outside its contract. Neither server age
nor a long build causes an automatic kill.

Each full permit passes `VITEST_MAX_WORKERS=4` and `TURBO_CONCURRENCY=4` to its
children. Lower them by setting the environment variable; never raise Turbo's
limit with `--concurrency` or `--parallel`. These limits do not cover arbitrary
subprocesses, so serialize compilers and multi-package tools inside one
permit. This repo's `pnpm typecheck` already does
([typechecking](../../../docs/typechecking.md)).

`--seat LABEL` labels the seat in status and `--holder ID` identifies its native
child; neither grants authority. Arguments after `--` belong to the child, and
the wrapper preserves its exit status and forwards interruption. Nested
commands with the same holder in the same verified process group reuse the
permit.

When your command exits, anything left in its process group (a test's server,
watcher or fixture) is a leftover. After a ten-second grace it gets SIGTERM, then
SIGKILL five seconds later, and the slot frees. Stop helpers in your own teardown
anyway: a leftover is killed, not drained.

## Waits and status

`clankie fleet resources` and `clankie doctor --json` show capacity, actual
holders, queue and pressure; `--machine ID` selects a registered host. A wait
can mean a full pool, high load, low available memory or unavailable native
observations. The reason names which: `busy` (load or memory guard), `slots`
(ceiling), `queued` (FIFO turn), or `service` (the service is deciding for you).
Keep the request open; repair an unavailable installation through the existing
setup route rather than selecting another registry.

Before stopping a queued job, verify its exact command, working directory and
your own launch record. A matching seat or holder alone does not identify the job.
A helper failure reports its exit, signal and native error; keep that exact
error for diagnosis instead of changing capacity or resubmitting a healthy
queued request.

The owner sets capacity with `clankie fleet set [--machine ID] --heavy-slots
auto|N --simulator-slots auto|N` or `/fleet resources`. Task-specific owner
budgets still bind, and a source or default change does not authorize raising
live capacity. Admission rules, holder alerts, disk guards and platform notes
are in [admission](reference/admission.md).

## Pairings created by automation

Use `clankie pair --run UNIQUE_ID --purpose simulator --ttl 900 -- COMMAND ARGS`
inside the governed command for captures and probes. The child receives
`CLANKIE_PAIRING_CODE`, `CLANKIE_PAIRING_URL` and `CLANKIE_PAIRING_RUN_ID`;
wrapper teardown revokes only its marked pairings and cancels unused offers.
Purposes are `test`, `proof`, `simulator` and `gateway-probe`. A fixed short TTL
revokes abandoned runs even after service replay. For custom runners, mint with
`pair --run UNIQUE_ID --purpose proof --json`, then call
`clankie devices end-run UNIQUE_ID` in `finally`. Never reuse an owner pairing,
mark a real owner's device as automation, or infer disposable identity by name.

## Proofs and fixtures

For source-checkout scratch service/relay proofs, use
`node scripts/scratch-stack.mjs .local/PROOF` and the same generated `stack.env`
for both heavy-wrapped entrypoints (`docs/cli.md`, "Scratch service and relay
proofs"). Include this in worker proof briefs; never leave either peer URL or
advertised relay at the installed `4310`/`4321` defaults.

Test and eval service fixtures must carry `VITEST=true` or `NODE_ENV=test` and
still run inside `clankie heavy`. A scratch `HOME` or `CLANKIE_STATE` alone does
not isolate a service from the live registry.

# Lease a simulator

Never boot with `xcrun simctl boot`, Simulator.app or a test runner that boots
its own device: a device booted outside a lease holds a fleet slot and other
lanes wait on it. Follow any task-specific owner approval before acquiring.

```sh
clankie simulator acquire '{"seatId":"SEAT","deviceType":"com.apple.CoreSimulator.SimDeviceType.iPhone-17","runtime":"com.apple.CoreSimulator.SimRuntime.iOS-26-0"}' --wait 600
clankie simulator verify '{"seatId":"SEAT","id":"LEASE_ID","deviceId":"UDID"}'
clankie simulator touch '{"seatId":"SEAT","id":"LEASE_ID"}'
clankie simulator release '{"seatId":"SEAT","id":"LEASE_ID"}'
```

`SEAT` accepts your exact terminal ID or pane ID, with a fleet prefix for a
named local fleet. In a Herdr pane that is `$HERDR_PANE_ID`; in a desktop-app
terminal (no `HERDR_PANE_ID`) it is `herdr-core/$HC_TERMINAL_ID`. The service proves the native session and live processes;
Codex does not need a Claude `messageReceiver` entry. Fresh hires establish their
own seat identity; never copy a lead's `CLANKIE_SEAT_*` values.

- `acquired`: use `lease.deviceId`, the exact UDID, for every simulator command.
- `booting`: the service is starting your device; the blocking acquire waits.
- `waiting`: every slot is held; `blockers` names holders and the queue ahead.
  Keep the request open or ask the named holder to release.
- `rejected`: act on `reason` (`service_restarting` retry shortly;
  `owner_unavailable` retry the same request; `device_unavailable` pick one of
  `alternatives`).

Verify before installing, launching or driving; abort the operation if it
refuses. Raw `simctl`, Xcode and external MCP tools must run that check
themselves. Never drive a sibling's device because its UDID is visible in
status, and never use your lead's or a sibling's holder identity. The ten-minute idle deadline starts when a verified holder returns to its prompt.
Fresh exact-holder native activity or a live queued/held heavy permit retains the
lease without model-driven touches. Heavy association requires both the task
holder and native process ancestry (pane and terminal aliases may differ); a
sibling or copied label cannot renew it.
Unknown/stale activity never renews time. Explicit touch remains available.

Codex roots/children use read-only native thread state and ancestry, including
after a service restart through the exact observed local native socket. No
Codex hook or plugin reload is needed. Claude children use finite original-native
renewals. Claude root UserPromptSubmit, PreToolUse and PostToolUse
hooks extend only that exact session's leases to one idle window from the event.
Ordinary tool renewal runs asynchronously behind a local lease-hint check; no
hint means no Node/HTTP work and no renewal. Hints grant no lease authority.
Stop, StopFailure and SessionEnd add no time; an interrupted root expires without
a matching Stop. New hook registrations apply only after a plugin reload or new
session; workers must not reload existing seats to obtain them.

A long wait must retain its lease through an owned process: use exact-holder
`clankie heavy --` for heavy work, and run that blocking command as a harness
background task. A background process alone does not retain a simulator lease;
there is no general simulator process-holder command yet. For Claude roots, a
non-heavy tool or quiet thinking beyond one window still needs a positive native
root-turn API.
Keep that gap explicit; never replace it with model sleep/touch loops. Explicit
touch remains available for a deliberate extension. Release when finished.
Details and source-proof limits are in the simulator reference.

Release, idle expiry or a verified seat exit shuts the device down and keeps it
for reuse; nothing deletes devices except an explicit owner tidy naming exact
stopped UDIDs. Never run global shutdown, erase, delete-all or unavailable-device
cleanup for fleet work. Queues, holder identity, device choice, usage readings,
runaway shutdown and create receipts: [simulators](reference/simulators.md).

For an already submitted integration request, run
`clankie integrate status UUID --wait` as a harness background task and continue
on its completion notice. A new `clankie integrate ... --push` already waits by
default. A terminal held, failed, cancelled or interrupted result remains that
result; waiting never resubmits or overrides it.
