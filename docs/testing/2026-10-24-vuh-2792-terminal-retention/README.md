# VUH-2792 — release native terminal payloads after dispatch

[Published proof archive](clankie://evidence/sha256/3d1c6d932ff2c8d685d9927a06b2c589ad04fdcb4804d1e281ef9d938709ebb2).

A Codex seat kept the last 64 full terminal events, including native item bodies,
for as long as the seat lived. An isolated replay of a real own-seat turn left
49.00 MB of JS heap after 96 completions. The candidate leaves 13.46 MB, while
preserving full first delivery and early-completion replay.

This is a scoped retention fix. VUH-2792 remains In Progress: the live service's
exact JS/heap attribution and comparable busy-fleet CPU/RSS improvement remain
unproven. The preceding landed receipt optimization showed no whole-service CPU
win (43.45% before, 46.75% after in sequential, changing live workloads).

## Ownership and behavior

`startCodexAppServerSeat` now retains identity/status proof in its existing
64-entry terminal history. A separate temporary map keeps full terminal events
only while a `turn/start` reply is outstanding and its early completion may need
to be replayed. Both acknowledgement and failure release that map. Its capacity
follows the existing 64-entry history bound.

Full notifications still reach the policy audit and event consumer. A completion
that beats the start reply remains intact until the confirmed turn identity can
replay it, including final agent text, failed/interrupted status and native error.
Idle reconciliation still uses the same native history proof; this patch changes
neither its requests nor native question, authorization or dispatch rules.

## Verification

- Real loopback WebSocket provider, production client/seat, Node `--expose-gc`
  and WeakRefs: the old source fails with **64** settled native item arrays still
  reachable; the candidate collects all of them.
- The same regression holds early completion alive while the reply is pending,
  proves full first delivery and replay for completed/failed/interrupted turns,
  and collects it after acknowledgement. It also covers idle-reconciliation
  completion before acknowledgement, rejected dispatch cleanup, and late-start
  suppression from compact terminal history.
- **82/82** checks pass across terminal retention, app-server, seat adapter and
  hired-seat protocol integration files. The root landing gate is separate.
- Heap snapshots show the old retainer chain:
  `observe → Context → Map → completion.params.turn.items[].text`.
  Synthetic 1 MB Unicode items reproduce the count-bounded plateau: 98.13 MB JS
  heap at 96 matching completions versus 14.47 MB for transient item delivery.
- The real private corpus is a **426,863-byte** native latest-turn reply with
  101 items, read once from this worker's own exact existing native seat. Only
  initialization and read-only inventory/latest-turn methods were sent: no
  resume, input, model call, account request or other-seat connection.
- Its turn data was copied into 96 completion fixtures with generated IDs and a
  completed status. This is a protocol replay, **not** an observed live completion
  frequency/distribution. Baseline and candidate use identical private input.

| After 96 matching real-corpus completions |      Baseline |     Candidate |
| ----------------------------------------- | ------------: | ------------: |
| JS heap after GC (`heapUsed`)             |  49,003,376 B |  13,456,336 B |
| Process RSS at that checkpoint            | 212,322,064 B | 100,193,632 B |

RSS is an observation, not a controlled whole-service memory saving. Profiles
include instrumentation and forced heap checkpoints; no native/live CPU saving
is claimed. Raw private frames and heap snapshots stay local. Published evidence
contains source/input hashes, CPU/allocation profiles, aggregate heap summaries,
replay scripts, and red/green logs.

## Other diagnostic observations

- A blank, isolated production scratch service has about 307 MB JS heap and
  555 MB RSS before fleet activity. Its snapshot has 327 MB aggregate self size,
  including 84 MB arrays, 77.5 MB strings and 59.2 MB closures. Startup allocation
  sampling identifies Zod/schema and bundled catalog construction, but allocation
  samples are not retained-owner/dominator measurements.
- A quiet 60-second production Herdr-feed probe parsed under 1 ms of catalog/ack
  traffic (4–15 KB replies); it does not establish cost under changing fleet events.
- The production remote fleet relay decoded 1,000 split frames / 61.46 MB with
  zero JSON parses. Its binary framing is distinct from downstream JSON consumers
  and from the separate relay process.
- A private 51,901,669-byte Codex rollout copy projects 3,731 entries / 9.12 MB.
  Telemetry repeatedly decodes and reserializes overlapping 2 MB tails when the
  file grows. Forty small generated appends plus cold reads generated 112,563
  instrumented JSON parses / 344.92 MB parsed. This is deferred to a follow-up;
  hook-inclusive timings are not a production cost benchmark. A separate
  uninstrumented operation replay is archived.

The isolated probes name exact reproduced parsers and retainers. They cannot
uniquely bind the live service's unsymbolicated `OnUvRead → JSON.parse` stack to
this path or identify its entire retained heap. No live inspector, injection,
restart or profiling switch was added. The lead owns deployment and the next
passive CPU/RSS measurement.

The deferred transcript-tail work is tracked in
[VUH-2803](https://linear.app/vuhlp/issue/VUH-2803).
