# VUH-1699 — remaining idle CPU costs

Candidate based on `origin/main` at `2e1c08be`. This is owned API/proof-host
measurement, not a deployed-runtime acceptance result.

## Live profile

Read-only sampling of runtime PID 59867 and helper PID 61729, followed by a
30.222-second inspector CPU profile, found these main-thread costs:

| Profile category                | Sampled time | Fraction of wall time |
| ------------------------------- | -----------: | --------------------: |
| Child-process dispatch          |      1.170 s |                 3.87% |
| Settings parsing and validation |      1.093 s |                 3.62% |
| Timer callback self time        |      0.080 s |                 0.26% |

These are V8 sample attribution, not CPU-seconds endpoint measurements. The
helper's five-second native sample spent 345/420 samples waiting for input and
75/420 in proof work. Of the active samples, 50 were in kernel process/socket
queries and 15 in argument-buffer handling. It does not busy-spin between jobs.
Fleet traffic and ambient machine load were uncontrolled; no play or model work
was introduced. No live runtime, lane or helper was restarted.

## Changes

- Identical freshly read settings bytes reuse their validated parse. Every
  caller gets a private copy; corrupt/changed files, read errors and descriptor
  generation fences retain their existing behavior.
- The helper uses Darwin's non-elidable `memset_s` to erase the same complete
  argument and protocol buffers instead of a volatile byte loop.
- Configured local roster, pane/process and snapshot reads use the existing
  Herdr JSONL socket transport. Waits and writes keep their current execution
  path. Native failures do not dispatch a fallback request.

## Matched owned measurements

The final before/after runs use identical fixture bytes, ten preserved older
worker bridges, restored private-seat registrations, real TCP/kernel proof and
an owned Herdr daemon. Both windows last 120 seconds. The baseline restores
unchanged main source bytes; the candidate changes only the service sources.
No providers, installed agent TUIs or live fleet lanes are started by the fixture.

CPU is CPU-seconds divided by elapsed wall time, expressed as percent of one
core. The process endpoint sampler verifies PID and birth at both endpoints.
Body `process.cpuUsage` is also retained. Own heavy checks were quiescent during
measurement; ambient fleet/machine load remained uncontrolled.

| Measure                           | Before |  After |
| --------------------------------- | -----: | -----: |
| API/proof host CPU                |  3.92% |  3.43% |
| Persistent proof helper CPU       | 17.54% | 11.46% |
| Owned Herdr CPU                   |  2.66% |  2.89% |
| Body reaped-child CPU, separately |  1.31% | 0.001% |
| Child-process dispatches          |    480 |      0 |
| Completed legitimate requests     |    520 |    520 |
| Successful peer discoveries       |    240 |    240 |
| Membership refusals               |  0/520 |  0/520 |
| Fresh broad fleet proofs          |    560 |    560 |
| Fresh native project proofs       |    480 |    480 |

Both peer tools remain advertised at startup and endpoint. Body CPU falls 12.5%
and helper CPU 34.6%. No admission TTL, partial census or proof-count reduction
accounts for this result.

Raw evidence is retained in the worker checkout's ignored `.local/`:
`orla/live-node.cpuprofile`, `orla/live-node-summary.json`,
`orla/live-runtime.sample.txt`, `orla/live-helper.sample.txt`,
`orla/comparison.json`, and
`project-proof/frequency/current-1791271678545/evidence.json` (before) /
`project-proof/frequency/current-1791271819048/evidence.json` (after).
The two preliminary matched windows are also retained; they isolate settings
parse reuse and secure wiping before the socket-read change.

## Verification and remaining work

83 settings/proof checks and 125 Herdr/recovery/peer checks pass, including real
file replacement/corruption/deletion, independent snapshots, real owned socket
reads, missing panes, missing sockets and unavailable bindings. The native
peer-authority boundary check and final static checks are recorded in the
worker's `.local/REPORT.md`.

The full live runtime's single-digit idle target remains unverified. The owned
host omits the captain, connected providers, remote fleets and app polling; its
already-low body CPU cannot establish that acceptance criterion. The helper
still spends 11.46% on the owned workload, dominated by required fresh kernel
censuses. Lead landing/deployment and a quiet 120-second live sample are needed.
The profile-enabled inspector on PID 59867 remains bound to `127.0.0.1:9229`.
