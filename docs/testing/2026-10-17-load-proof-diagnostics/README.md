# VUH-2345: retain the intermittent membership refusal cause

The load gate now wires the existing diagnostics callback into both local fleet
and project proof. Fixed diagnostic events travel over the real service's IPC
channel into the report's `proofDiagnostics` array, with pane, request and
connection IDs. They survive independently of the last 8,000 service-log bytes.
Successful proofs and socket-owner observations are omitted. No proof decision,
native helper, scan limit, transport timeout or release budget changed.

The real IPC regression starts the load service and controlled HTTP provider in
owned processes. HTTP requests with an invalid pane claim at the events (fleet
proof) and peers (project proof) routes are refused with 403 and produce the exact
correlated `invalid_pane` diagnostics over IPC, with distinct request IDs. Their
captured messages contain no fixture bearer. The test passed in 4.55 seconds
under `clankie heavy`; no native observation or admission result is mocked.

## Reproduction and limits

All runs used one heavy job at a time, ten ready bridges, the default 120-second
measurement and unchanged budgets, on source HEAD `1eb84aea6` with the diagnostic
patch present. No shared service restart or PC operation was performed.

| Run                             | Outcome | CPU mean | Health p95 | Tool p95 | Refusals |
| ------------------------------- | ------- | -------- | ---------- | -------- | -------- |
| First, normal helper            | Failed  | 4.78%    | 109 ms     | 1432 ms  | 4        |
| Second, normal helper           | Passed  | 4.93%    | 78 ms      | 528 ms   | 0        |
| Third, private profiling helper | Passed  | 4.42%    | 64 ms      | 471 ms   | 0        |

The first run reproduced `Local fleet membership unavailable` on `w1:p2`.
Request `6bb5517e-7350-43fd-9df3-d743171d1afa` retained native final-scan
`budget_exhausted`, followed by `native_final_unavailable`. Other failures
included initial-scan exhaustion and one helper transport timeout. The native
200 ms attempt / 600 ms total bounds and 1-second transport timeout held.
`EINVAL` process errors in these chains follow the exhausted budget check;
they do not establish a separate process-lifetime bug.

A private copy of the unchanged C algorithm added timing counters. Two isolated
profile cohorts (12 and 200 real socket censuses) all passed. The longer cohort
had p95 26.6 ms including helper launch. The third full workload temporarily
selected that instrumented binary through the local fixture configuration and
recorded all 780 persistent-helper jobs passing: maximum scan wall time
54.9 ms, p95 29.9 ms, maximum CPU time 24.0 ms. A typical scan reads roughly
2,200 process FD tables, 4,700 BSD identity snapshots and 4,100 socket records.
The temporary profiling override was removed before landing. The profiling
binary and raw process-lifetime snapshots remain private and are not shipped.

**Inference, not a root-cause finding:** a brief deschedule or blocking kernel
read fits the failing wall-budget exhaustion better than a steady scan-cost
bottleneck. The profiler has not caught that stall. The passing retries do not
resolve the intermittent bug. Per the lead's direction, this commit lands only
the diagnostic wiring and regression; **VUH-2345 stays open** while the stall is
investigated. No scan optimization is claimed.

Full load packets are retained in the [evidence manifest](evidence.json).
Focused-check output remains in `.local/vuh-2345/diagnostics-test-final.log`.
Landing results and the final SHA are posted on the issue.
