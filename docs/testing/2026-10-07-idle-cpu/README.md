# VUH-1699 / VUH-1702 — idle CPU and alert verification

Source baseline: `4b9c935fe0ecf711ae41be7673c302479380dada`.
The live service was inspected without restarting, deploying, signalling or opening
an inspector. Profiling used a separate process with CPU profiling at startup.

## Live measurement

The issue's historical measurement was about **43% of one core**. On
2026-10-07 the current live service measured **10.872%** over **120.068 seconds**,
with fresh native HTTP `/health` p95 **4.392 ms**, 25 successful responses and
unchanged PID `53563` / process instance. The launcher PID `53441` is a wrapper,
not the process whose counters were measured. [Counters and samples](live.json)
retain both endpoint CPU and uptime values.

This historical 43% → 10.9% comparison reflects previously landed work; it is
not a matched experiment establishing the effect of this change. No model/play
work was introduced. Ambient fleet traffic was uncontrolled, and helper/child
CPU is outside the service counters. Single-digit live idle remains unproved.

A ten-second native sample found 7,177 of 7,721 main-thread samples in `kevent`.
Active stacks included file-close promise handlers and object copying; native
stacks do not identify their JavaScript callers. The earlier approximately 31%
observer reading fell as startup/hiring activity settled; it is not the baseline.

## Isolated startup CPU profile

An isolated HOME, state and ephemeral HTTP port hosted the real Captain/API,
ten five-second roster pollers, one one-second mailbox poll and the configured
read-only local/remote fleet inventories. Node started with `--cpu-prof`; no
inspector port opened. The 120-second window measured **7.060% CPU**, **1.913 ms
health p95**, **352 completed polling requests**, zero errors and zero model
turns. [Profile summary and counters](profile.json) retain the scope.

After omitting the first 15 seconds, V8 self samples attributed approximately
115.31 seconds to idle, 0.60 seconds to seat telemetry, 0.31 seconds to transcript
parsing, 0.28 seconds to native Codex goal reads, 0.20 seconds to redaction and
0.12 seconds to subprocess dispatch. These are sample attribution, not CPU
counter time; anonymous transpiled frame line numbers are not precise source
locations. No single hot busy loop was reproduced.

This instance omits live provider/credential traffic, native controller
registrations, worker MCP proof-request traffic and persisted addressed-seat
transcript state. It therefore does **not** explain the remaining live 10.9%.
A profile enabled through the launcher at the next planned restart is needed to
attribute that complete workload. Raw native/V8 profiles and the executable
fixture remain in this checkout's ignored `.local/vuh1699/` and
`.local/vuh1699/isolated-fixture.mts.txt`; the fixture derives from the prior
[owned measurement](../2026-10-06-kai-runtime-cpu-alert/owned-measurement.mts.txt).

## Settings-copy reduction

Every settings read still reads fresh file bytes. Unchanged exact bytes now
reuse validated normalized JSON and parse a private copy, replacing the more
expensive structured clone. Validation, errors, compatibility views, replacement
and descriptor-generation freshness fences remain in place.

A non-secret synthetic 120-project, 27,063-byte normalized fixture measured:

| Measure                                |    Before |     After |
| -------------------------------------- | --------: | --------: |
| 20,000 actual settings loads, CPU ms   | 5,049.357 | 3,400.001 |
| 198 loads at about 10 Hz, CPU ms       |    92.801 |    76.354 |
| 10 Hz fixture CPU, percent of one core |    0.463% |    0.381% |

[Raw counters](settings.json) retain wall time and copy-only controls. The
[synthetic measurement fixture](settings-measurement.mjs.txt) runs from
`.local/vuh-1699-settings/` through
`clankie heavy -- node .local/vuh-1699-settings/settings-measurement.mjs`. Actual
load CPU fell 32.7% in the throughput case and 17.7% in the paced case. Ambient
machine load varied; this small saving does not explain the historical 43% or
establish any after-change live result. The live process remains unchanged.

## Checks and remaining acceptance

Settings read/fence, legacy Linear-wake migration and fleet-autonomy integration:
29 tests across four files passed. Settings typecheck passed. The existing
integration proves independent first/cached snapshots, nested compatibility
views, file replacement/corruption/deletion and freshness refusal.

The service lifecycle suite passed 82 tests, including a real installed Node
profile and a real checkout controller/native preparation/tsx child whose owned
SIGTERM shutdown flushes one profile. Existing `NODE_OPTIONS`, default-off
behavior, helper isolation and no inspector flags are covered. TUI typecheck
passed. Scoped formatting and lint passed; the documentation link check
resolved all 493 Markdown files. Profiling is available through `CLANKIE_CPU_PROFILE_DIR` in the actual
launcher environment; see the [CLI lifecycle reference](../../cli.md).

VUH-1699 stays open for the next planned profiled restart and attribution of the
remaining live cost. VUH-1702 live defaults/status and isolated alarm/recovery evidence follow.

## VUH-1702 live status and isolated incident

[Live status evidence](live-alert-status.json), captured 19:13Z, shows enabled
50% CPU / 1,000 ms health thresholds, five-minute dwell, 15-second samples and
30-minute cooldown. Status and doctor report healthy, 10.6% CPU and 1 ms health.
There was no qualifying alarm or delivery event since this runtime boot. No
live thresholds, load, native bindings or lanes were changed.

Two real isolated integration cases passed through `clankie heavy` (2 files,
2 tests, 8.84 seconds):

- Real slow HTTP with no native seat records exactly one alarm and recovery in
  `global-default`, reports `recorded: true` / `delivery: unavailable`, deduplicates
  a retried notice, records incident duration and starts zero model turns. This
  case uses a 100 ms health threshold and accelerated 300 ms dwell.
- Real CPU work, slow HTTP, an owned Herdr session and protocol receiver produce
  one alarm at 19:25:48.602Z (61.4% CPU / 1,104 ms health), then one recovery at
  19:25:50.059Z (21.9% CPU / 1 ms health), recording a 2,680 ms incident. Both
  exact event IDs receive `acknowledged: true` / `deliveryStage: delivered`; zero
  model turns. CPU/health thresholds remain the defaults, with accelerated
  400 ms dwell, 100 ms sampling and 60-second cooldown. The native fixture omits
  the record callback, so its `recorded: false` is expected; the first case proves
  durable recording. [Exact isolated events and ACKs](isolated-alert.json).

This proves the isolated detector, recording, deduplication, recovery and
mailbox transport boundaries. The receiver is a protocol client, not the
owner's native TUI. Five-minute production dwell was not repeated here; the
[earlier exact-default run](../2026-10-06-kai-runtime-cpu-alert/README.md#native-alert-route)
retains that evidence. Actual current owner alarm/recovery and its next Linear
check-in remain unproved without a qualifying live incident.
