# VUH-1699 / VUH-1702 / VUH-1707 — Kai evidence

Candidate branch `fix/kai-runtime-cpu-alert`, based on `7ee4da04`.
Source: [`c9475545`](https://github.com/Volpestyle/clankie/commit/c9475545b10069bf3a65bcee2633461fdc7905da).
Sustained detector probe correction:
[`f7942f2d`](https://github.com/Volpestyle/clankie/commit/f7942f2d8bbe1a3e238d6cf171fe16dc34c77d4f).
The lead holds this stack pending the latency follow-up below and composed
acceptance. Integration also requires the capture-only Windows
correction described below and present in this branch's
[observer command](../../../apps/clankie/src/herdr-fleet.ts).
This is an owned Captain/API result. Full live single-digit idle and actual
owner native TUI acceptance remain open.

## Read-only live profile

The original live runtime `7ee4da04`, Node PID 74279, was sampled without a
restart. `SIGUSR1` enabled its loopback inspector; only Profiler commands were
used. V8 sampled 30.225 seconds at 1 ms; macOS `sample` ran 15 seconds at 5 ms.
No runtime evaluation, model turn, lane steering or credential change was used.

The top identified spawn stacks were 576.830 ms in remote placement snapshots,
573.544 ms in the separate remote agent list, and 123.637 ms in per-pane local
bridge process-info reads. These are V8 sample attribution, not CPU-seconds.
Credential broker reads and Codex adapter subprocesses also remain visible;
they were not changed. Raw profiles stay in the worktree's ignored `.local/live/`.

The candidate reads complete remote occupants and placement from one fresh
Herdr snapshot. Local bridge process-info uses the existing native socket reader.
Fresh Windows census reads can use the existing authenticated resident relay;
writes and cancellable waits keep their original transport. A failed attempted
relay observation is not replayed over SSH. No admission TTL or proof relaxation
was added.

## Matched owned CPU measurements

A real frozen install and built native proof helper were present for both runs.
The baseline restored unchanged main source bytes; the candidate used the branch
sources. Both used a real Captain, settings/file memory and HTTP API, ten polling
clients, the same registered `pc`/`kh2` read-only inventories, and an operator
mailbox poll. Each window sampled `/health` 25 times, five seconds apart, checking
stable PID and process-health boot identity. CPU is the difference in the body
process's user+system CPU counters divided by its uptime difference, as percent
of one core. Own builds/tests were quiescent during these windows.

| Measure                    |    Before |     After |
| -------------------------- | --------: | --------: |
| Window                     | 120.048 s | 119.899 s |
| Captain/API CPU            |     3.28% |     2.83% |
| `/health` p95              | 100.80 ms | 297.81 ms |
| Completed polling requests |       351 |       352 |
| Request failures           |         0 |         0 |
| Service model turns        |         0 |         0 |
| Local Herdr subprocesses   |       264 |         0 |
| SSH subprocesses           |       224 |       110 |
| `ps` subprocesses          |        88 |        88 |

CPU fell 13.7% relative in this component workload. Health tail latency rose;
ambient fleet/machine traffic was uncontrolled, so no latency improvement or
canary pass is claimed from that original pair. The owned workload omits connected
providers, app traffic and legacy installed worker transports; it cannot establish the original live
13.21% target. It did not start resident remote relays, so that optimization is
covered by transport checks rather than these numbers. Helper/Herdr/remote CPU
is not included in body CPU. [Before](before.json) and [after](after.json) retain
exact counters. The executable fixture and raw samples remain under ignored
`.local/bench/`; invalid authentication/preparation trials are retained and excluded.

## Health latency hold: bisect, cause and correction

The lead held `53cb4c91` because the original pair's p95 rose from 100.80 to
297.81 ms. Four serial owned instances used the exact original pooled-fetch
fixture, unchanged install, warmup, workload and CPU math:

| Source                            |    CPU | Health p95 |
| --------------------------------- | -----: | ---------: |
| `7ee4da04`, first baseline        | 3.907% | 120.938 ms |
| `c9475545`, census/native routing | 3.266% | 119.036 ms |
| `53cb4c91`, Windows correction    | 3.714% | 145.989 ms |
| `7ee4da04`, repeated baseline     | 3.027% | 208.470 ms |

This bisect does not establish a source-caused latency regression. Even unchanged
baseline varied from 120.94 to 208.47 ms. The workload never starts a resident
relay, so the Windows correction is not executed in these measurements.
[Bisect counters and all 100 samples](latency-bisect.json) retain the failures of
the original measurement assumption; the original 100.80/297.81 pair stays above.

A passive trace on `53cb4c91` isolated the worst pooled request:

| Phase                               |   Duration |
| ----------------------------------- | ---------: |
| Complete pooled request             | 212.055 ms |
| Request created to headers sent     | 211.097 ms |
| Event-loop idle during request      | 211.010 ms |
| Server handler                      |   0.367 ms |
| Following fresh native HTTP control |   1.311 ms |

The delay precedes sending; it is not a 212 ms health handler or sustained CPU
work. This matches the installed Node idle-fetch issue already documented in the
[VUH-1707 health investigation](../2026-10-05-health-latency/README.md).
[Passive timestamps and controls](passive-client-delay.json) use diagnostics
channels and event-loop counter deltas, with no profiler, histogram or new timer.
They are diagnostic evidence, with 25 additional control requests. An earlier
diagnostic used a 10 ms event-loop histogram and is excluded: that wakeup can
hide the delay.

The owned measurement now uses the deploy sampler's fresh native HTTP transport,
with a five-second full-body timeout and 32 KiB bound. **Both baseline and
candidate use that method.** Ten roster pollers, one mailbox poll, 25 five-second
health samples, ten-second warmup, installed dependencies and CPU counter math
stay unchanged. Two serial pairs on the same source inputs produced:

| Pair     | Source     |    CPU | Health p95 | Poll requests | Errors / model turns |
| -------- | ---------- | -----: | ---------: | ------------: | -------------------: |
| A before | `7ee4da04` | 3.558% |  22.237 ms |           352 |                0 / 0 |
| A after  | `53cb4c91` | 2.922% |  17.970 ms |           352 |                0 / 0 |
| B before | `7ee4da04` | 3.473% |  27.019 ms |           350 |                0 / 0 |
| B after  | `53cb4c91` | 2.648% |  16.932 ms |           352 |                0 / 0 |

[Matched native records](native-health-pairs.json) retain all counters and 100
samples. Each window has one stable process/boot identity. CPU and p95 improve
together in both pairs. These are component measurements; they do not establish
single-digit idle for the complete live service. Ambient fleet work remains
uncontrolled, and helper/remote CPU is excluded. The original pooled baseline
must not be compared with a fresh-native candidate as a matched pair.

The production sustained detector also still used pooled fetch, even though the
deploy canary already used fresh native HTTP. The follow-up shares the existing
bounded native probe with `RuntimeHealthObserver`, including caller shutdown,
complete-body timeout, status refusal, 32 KiB limit and local endpoint validation.
Thresholds, incident duration, cooldown and native receipt fences are unchanged.
A real TCP integration failed before the change because three idle probes reused
one connection; it passes after the change with three fresh connections and no
authorization header. The existing sampler's timeout/body/identity cases remain
green. No global dispatcher or periodic wakeup was added.

The final committed-source `f7942f2d` window used the same fresh-native fixture:
**3.499% CPU / 19.624 ms p95** over 119.999 seconds, 352 poll requests, zero
errors and zero model turns. Its CPU lies within the two fresh-native baseline
values (3.473–3.558%); p95 is below both baseline values (22.237–27.019 ms).
This does not establish an additional CPU reduction from the detector transport
change. The fixture constructs the Captain/API, without starting the sustained
observer; that observer's behavior is covered by the real HTTP and default alarm
checks. [Final source counters, hashes and samples](final-native-health.json)
retain the exact inputs. Own heavy checks finished before the measurement window;
no profiler, histogram or comparative control ran during it.

The exact executable fixtures are archived as text: [original measurement](original-measurement.mts.txt),
[fresh-native measurement](owned-measurement.mts.txt), and [passive diagnostic](passive-diagnostic.mts.txt).
Run the selected fixture from `apps/clankie/.local/` so it resolves the app's real
installed dependencies. The output goes to the root worktree's ignored `.local/bench/`.
For example, from an owned, installed worktree at the selected source:

```sh
mkdir -p apps/clankie/.local
cp docs/testing/2026-10-06-kai-runtime-cpu-alert/owned-measurement.mts.txt \
  apps/clankie/.local/bench-native.mts
~/.herdr-handoffs/clankie-backlog-20261003/bin/heavy clankie heavy -- \
  pnpm --filter @clankie/clankie exec tsx .local/bench-native.mts UNIQUE_RUN_NAME
```

The fixture reads the already-configured inventories; it does not launch or
steer existing lanes, publish a resident relay, or reproduce external providers.

## Real Windows observer correction

Pell's review found that `RemoteFleetRelay.execute` decodes the PowerShell
command and runs the resulting script inside the resident host. The original
native CLI wrapper wrote raw bytes to the host's stdout and called `exit`, which
could corrupt binary framing and terminate the relay. The earlier fixture
returned canned command output and did not exercise that Windows script.

The manual real Windows test reproduced a disconnect on its first `api snapshot`
before the correction. The observer now captures the owned native child's UTF-8
stdout and stderr concurrently, returns text through the PowerShell pipeline,
checks JSON/exit status, and bounds/disposes its own child. It never writes raw
console bytes or exits the relay host. Non-JSON CLI failures return a fixed error
envelope; no attempted observation is replayed over SSH.

After the correction, an owned Windows PowerShell/C# relay over actual SSH ran
installed Herdr's `api snapshot`, `agent list`, `pane list` and another snapshot.
A nonexistent session returned `fleet_command_failed`; a following valid snapshot
and a Unicode probe succeeded on the same living relay. No link file was
published, no existing pane was changed, and no SSH fallback occurred.
[Real Windows receipt](windows-observer.json) records payload sizes and timings.
The first four native reads took 171.51, 53.17, 55.06 and 42.15 ms. These are
command timings, not an idle CPU comparison. The owned CPU measurements above
remain valid because that workload did not create resident relays.

The test is manual only and requires an explicitly selected, already-authenticated
Windows destination with an installed Herdr session:

```sh
~/.herdr-handoffs/clankie-backlog-20261003/bin/heavy clankie heavy -- \
  env WINDOWS_CENSUS_HOST=USER@HOST WINDOWS_CENSUS_SESSION=default \
  pnpm exec vitest run --config vitest.config.ts \
  apps/clankie/test/windows-census-observer.integration.test.ts
```

## Native alert route

A fresh kernel-proven operator catalog may preserve its already-attached exact
native conversation binding. Bare transcript discovery still requires complete
registered inventories; an unrelated unreachable inventory can legitimately
refuse that discovery. This candidate does not claim the original unavailable
canary's precise cause or retry its original alert.

`native.health_alert.delivery` records a content fingerprint, conversation,
submitted/unavailable outcome and fixed reason. Message content and raw provider
errors are omitted. Submitted includes retained uncertainty after native
dispatch; it is not proof that the owner read it. Original receipts remain fenced.

The owned integration uses actual Herdr, CPU work, HTTP delay, transcript
attachment, the default operator outbox and exact event acknowledgments. Its
receiver is an ordinary Node protocol client, not Claude or another model/TUI.
The production kernel/project proof correctly rejects its claimed native
harness catalog (`native_session_required`), and no nativeSource is recorded.
Thus this checks detector-to-outbox delivery and the refusal boundary; it does
not prove the positive native catalog binding or original owner TUI receipt.

The normal focused test uses 50% CPU, >1 s health and an accelerated 400 ms dwell.
A separate explicit manual run uses every default, including five-minute dwell,
15 s sampling and 30-minute cooldown:

```sh
~/.herdr-handoffs/clankie-backlog-20261003/bin/heavy clankie heavy -- \
  env RUNTIME_HEALTH_NATIVE_MANUAL=1 pnpm exec vitest run \
  --config vitest.config.ts apps/clankie/test/runtime-health-native.integration.test.ts
```

The exact-default manual run was repeated after the fresh-probe correction and
passed in 324.5 seconds. One alarm was acknowledged at 14:25:11.744Z after
306,587 ms: CPU 61.3%, health 1,111 ms. One recovery was acknowledged at
14:25:26.892Z after a 321,736 ms incident: CPU 7.6%, health 1 ms.
Both original event IDs received `acknowledged:true`, `deliveryStage:delivered`;
both diagnostic outcomes were `owner_mailbox_delivered`. Service model turns: 0.
The configured cooldown and no duplicate alarm while still hot are checked;
waiting a full 30 minutes or rearming another incident was not performed.
[Exact default receipt](native-defaults.json) contains the alarm, recovery, original
IDs and acknowledgments. This is protocol-client evidence, not an installed
native TUI receipt or a completed owning-lead Linear check-in.

## Checks and handoff

The earlier census/routing/Windows gate passed Clankie typecheck, changed
TypeScript lint/format, 47 tests across six affected files, the exact-default
manual, real Windows test and Markdown links. The fresh-probe follow-up passed
typecheck, changed TypeScript lint/format and 13 cases across the observer,
sampler and native-delivery integration files, plus the repeated exact-default
manual. The documentation link check passes across 455 Markdown files.
The real owned Herdr checks
confirm fresh complete snapshots, changed names, missing sockets and no subprocess
fallback. The resident relay fixture still has a boundary at remote PowerShell/C#;
the separate manual test above proves actual installed Windows census execution
through the corrected fast path. Existing owner-change, uncertain-receipt and native
alert routing coverage passes.

Pell advanced the live runtime independently to `2acffdcf` during the original work.
Its warm canary was 17.18% CPU / 2.03 ms health p95 and native alert unavailable;
all six holds were preserved. Kai did not update/restart the live runtime, steer
lanes or alter holds/budgets. The old profiled PID 74279 still listens on loopback inspector port 9229, but
PID 45927 owned the active HTTP port 4310 at that observation. The old process was left untouched
and reported 0.1% instantaneous CPU in a read-only check; this is not a sampled
idle result. Pell was notified.

After the lead releases the source hold, Pell must integrate and check the
composed source, then measure the full live body with the same quiet 120-second
endpoint method. VUH-1702 still needs a controlled
alert/recovery accepted by the actual original owner native lane and its next
Linear check-in. VUH-1707's native-unavailable gap remains open until that route is
proved. No issue was closed or deploy hold cleared by this branch.

Ash's retained update receipt, source snapshot and process start-time chain now
identify the original bridge PID 51139's loaded source as `e1f45750`. That pump
throws after a failed or throwing acknowledgment, following notification.
The exact triggering error remains unproved; the original stderr/receipt loss was
not retained. Neither worker plugin telemetry nor an installed manifest proves
the loaded code. Ash's Linear-wake fix recovers retained context only after the
original native poll binds again; it does not revive this already-loaded stopped
pump. Original owner acceptance therefore needs the lead's supervised MCP
reconnect in the same Claude conversation, preserving pane `w3Z:p2N`, session
`5bcd52ff-8d50-4139-962a-46b323c7a990`, `global-default` and original receipt
fences. Kai's machine setup grant excludes existing-lane steering/restarts.
The lead must select that recovery before the controlled original-TUI alarm,
recovery and next Linear check-in can be proved. A protocol ACK or a retained
`message_clankie` handoff does not establish those acceptances.
