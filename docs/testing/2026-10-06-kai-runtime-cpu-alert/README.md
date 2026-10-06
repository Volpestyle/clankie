# VUH-1699 / VUH-1702 / VUH-1707 — Kai evidence

Candidate branch `fix/kai-runtime-cpu-alert`, based on `7ee4da04`.
Source: [`c9475545`](https://github.com/Volpestyle/clankie/commit/c9475545b10069bf3a65bcee2633461fdc7905da).
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
canary pass is claimed. The owned workload omits connected providers, app traffic
and legacy installed worker transports; it cannot establish the original live
13.21% target. It did not start resident remote relays, so that optimization is
covered by transport checks rather than these numbers. Helper/Herdr/remote CPU
is not included in body CPU. [Before](before.json) and [after](after.json) retain
exact counters. The executable fixture and raw samples remain under ignored
`.local/bench/`; invalid authentication/preparation trials are retained and excluded.

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

The exact-default manual run passed in 324.4 seconds. One alarm was acknowledged
at 13:16:07.393Z after 306,413 ms: CPU 61.1%, health 1,120 ms. One recovery was
acknowledged at 13:16:22.539Z after a 321,559 ms incident: CPU 7.6%, health 1 ms.
Both original event IDs received `acknowledged:true`, `deliveryStage:delivered`;
both diagnostic outcomes were `owner_mailbox_delivered`. Service model turns: 0.
The configured cooldown and no duplicate alarm while still hot are checked;
waiting a full 30 minutes or rearming another incident was not performed.
[Exact default receipt](native-defaults.json) contains the alarm, recovery, original
IDs and acknowledgments. This is protocol-client evidence, not an installed
native TUI receipt or a completed owning-lead Linear check-in.

## Checks and handoff

Clankie typecheck, changed TypeScript lint/format, 47 tests across six affected
files, and the 454-file Markdown link check pass. The additional exact-default
manual test passes (48 distinct affected cases total). The real owned Herdr checks
confirm fresh complete snapshots, changed names, missing sockets and no subprocess
fallback. Resident relay checks use real child/TCP framing with the existing
fixture boundary at remote PowerShell/C#; actual Windows census execution through
that fast path is not claimed. Existing owner-change, uncertain-receipt and native
alert routing coverage passes.

Pell advanced the live runtime independently to `2acffdcf` while this work ran.
Its warm canary was 17.18% CPU / 2.03 ms health p95 and native alert unavailable;
all six holds were preserved. Kai did not update/restart the live runtime, steer
lanes or alter holds/budgets. The old profiled PID 74279 still listens on loopback inspector port 9229, but
PID 45927 now owns the active HTTP port 4310. The old process was left untouched
and reported 0.1% instantaneous CPU in a read-only check; this is not a sampled
idle result. Pell was notified.

Pell must integrate and check the composed source, then measure the full live body
with the same quiet 120-second endpoint method. VUH-1702 still needs a controlled
alert/recovery accepted by the actual original owner native lane and its next
Linear check-in. VUH-1707's native-unavailable gap remains open until that route is
proved. No issue was closed or deploy hold cleared by this branch.
