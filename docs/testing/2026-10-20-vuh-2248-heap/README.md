# VUH-2248: the retained-request leak was already fixed

[VUH-2248](https://linear.app/vuhlp/issue/VUH-2248) is verified by existing commit
[`6edbcf19d`](https://github.com/Volpestyle/clankie/commit/6edbcf19df9d7ddab28bbd25328d448cbf183204).
The cause was the pinned MCP SDK's JSON-response stream mapping retaining answered
HTTP requests. That October 15 fix predates this investigation and follows the
October 14 runtimes cited in the issue. **No new product fix is needed.**

## Snapshot attribution

The counterfactual uses the existing
`worker-mcp-session-memory.integration.test.ts` on `c5565b8a9`, with identical
source and dependencies. A private Node load hook removes only the existing
`stream.cleanup()` patch in the unpatched process. Both runs use real loopback
HTTP, `LocalFleetLink`, `WorkerMcp`, one session and 1,000 additional requests.
The existing admission callback is a fixture; native process admission is not
under test. Snapshots follow the same warmup and timer-settling interval.

| Measurement                                                       |                          Unpatched |            Existing patch |
| ----------------------------------------------------------------- | ---------------------------------: | ------------------------: |
| Answered requests, before → after                                 |                         51 → 1,051 |                51 → 1,051 |
| `_streamMapping` entries                                          |                         51 → 1,051 |                     0 → 0 |
| Map retained bytes                                                |               622,968 → 12,959,992 | 184 in the final snapshot |
| Map growth per additional request                                 |                       12,337 bytes |                   0 bytes |
| Whole-heap growth per 1,000 calls, including JIT/fixture overhead |                          16.10 MiB |                  3.31 MiB |
| Reachable request attributions                                    | 1,051: expected regression failure |                ≤1: passed |

The growing owner is
`WebStandardStreamableHTTPServerTransport._streamMapping` → backing table →
settled stream entries and their `resolveJson`/`cleanup` closures → HTTP request
and authority graphs. The unpatched diff adds exactly **1,000 `IncomingMessage`,
1,000 `ServerResponse`, 3,000 `AbortSignal` and 2,000 `ReadableStreamState` objects**.
Its map is snapshot object `2992275`, transport `2992273`, and final backing table
`3345131`. With the patch, completed requests leave neither stream entries nor
request attributions. This is an upstream dependency lifecycle bug with an
existing local fix, not an integration-history leak.

## Hour-apart private service snapshots

One private source service, PID `48094`, ran `c5565b8a9` on loopback port `55517`,
with separate HOME, state, settings, credentials and test fleet registry. It
polled 838 synthetic failed integration records and listed the 100 operator MCP
tools on one persistent session at a target rate of once per second. No tools,
models, Discord accounts or native agents were invoked. Browser and Herdr were
disabled. The service stopped immediately after the hour-pair capture; its
server permit was confirmed released. No private services or samplers remain.

| Measurement                                           | Result                                               |
| ----------------------------------------------------- | ---------------------------------------------------- |
| Quiescent snapshot timestamps                         | 14:57:57Z and 15:57:57Z, October 20                  |
| Post-GC heap                                          | 282,076,160 → 282,586,832 bytes: **+0.49 MiB/hour**  |
| Snapshot graph retained bytes, including native nodes | 313,206,961 → 313,787,409: +580,448 bytes            |
| Natural RSS after ten-minute warmup                   | 711.5–745.9 MiB; **−1.35 MiB/hour**, −0.18%/hour OLS |
| First/last ten-minute RSS medians                     | 731.1 → 730.1 MiB                                    |
| First/last ten-minute process CPU                     | 6.37 → 5.82 CPU-seconds/minute                       |
| Completed-request stream/request maps                 | 0/0; each map retains 184 bytes in both snapshots    |

The largest fixed retainers include the model-catalog source string (9.85 MB),
parsed/bundled catalog objects (4.34/4.60 MB), Node's module loader (6.37 MB), and
Zod discriminated-union graphs (about 2.27/2.06 MB). They are baseline residency,
not accumulating completed requests. The hour diff and named-owner summaries
are archived with the snapshots.

Natural memory/CPU/load samples were taken every minute. Only snapshots forced
GC; traffic was paused and drained first. Snapshotting itself inflated RSS:
the final capture raised it from 728 MiB to 1.56 GiB. Those diagnostic spikes
are excluded from the RSS growth calculation. Dominator analysis follows strong
snapshot edges, excludes weak edges, and compares stable object IDs within each
process; raw snapshots remain available for inspection.

## The 838 integration records

The existing reader's early one-to-five-minute diff grows only 0.74 MB in total.
Its largest new graph, 1.28 MB under `ReadFileJob` and async generators, is one
in-flight partial census; the quiescent hour pair above removes that ambiguity.
Merritt's `2ffb40e14` cache holds **2,297,280 bytes** for the 838 records in the
cache-only snapshot, bounded at 4,096 entries. That is a small resident cache,
not the reported gigabyte/hour growth. The cache trial was stopped to release a
server slot; no hourly cache comparison is claimed and no cache fix is duplicated.
The hour-long run uses the original reader, demonstrating stable retention under
its repeated parsing workload.

## Live observations and limits

Only authorized `ps -o pid,etime,rss -p PID` reads touched the live runtime.
PID `92737` (`8bf44b375`) was observed separately from replacement PID `79170`
(`3f05e78b3`, deployed around 15:29:20Z). The old PID's short window rose from
814 to 1,009 MiB; the new PID's first three samples were 934 → 998 → 897 MiB.
These are variable working-set samples, not proof of a live retained-heap leak
or a continuous three-hour stability pass. Restarts are never blended into one
uptime slope. The sampler was stopped at the lead's instruction; **the longer
live sample and issue closure remain with the lead**.

The private workload does not replay live conversation, Discord or native fleet
activity. The earlier [October 15 attribution](../vuh-2216-runtime-heap-20261015/README.md)
assigned 77% of sampled growth to this path; this report does not retroactively
attribute the remaining 23%. It proves the specific leak by counterfactual
snapshots and verifies flat retained heap on the current private workload.

## Evidence and checks

Raw snapshots, analyses, measurements, reproduction hooks and test logs are in
the evidence store, indexed by `evidence.json`:

- [Unpatched request-retention snapshots](clankie://evidence/sha256/9687489ceb307bd40ac1171054b865eabf563ff382fd7e22c020013b91745b76).
- [Patched request-retention snapshots](clankie://evidence/sha256/ad98ceb43312e1ccd22d99164109f10919a92d01ec1a1e547958195c068b6a4b).
- [Hour-apart private snapshots and measurements](clankie://evidence/sha256/4d677f46d7faf0654a367b7896a7f28189ad713391dd69bc419e6b7ffdf7ff1f).
- [Integration-record census snapshots](clankie://evidence/sha256/67a67deff9c9a7680cc9426d6d056d7fc1b9fda71e685ecf5abe08c161dcfb80).
- [Methods, hashes and all live samples](clankie://evidence/sha256/41b939212275d8f38293eea7b8829fba82e5922506a3537e2b556ed9bd756523).
  Source/test hashes and the
  isolated runtime settings are described in `methods-and-samples.tar.gz`.
  No live inspector, signals, restart or application interaction was used.

The existing memory integration test passed ordinarily and with snapshot
instrumentation. Its unpatched counterfactual failed the intended reachability
assertion. Formatting and the root landing gate are reported with the submitted
commit and integration request.
