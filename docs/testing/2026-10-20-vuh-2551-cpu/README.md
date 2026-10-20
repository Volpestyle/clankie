# VUH-2551: runtime CPU and retained integration record reads

Tracks: https://linear.app/vuhlp/issue/VUH-2551

The live `8bf44b375` service used **37.04% CPU** over 181.34 seconds. A controlled
source service with 838 retained records and one queue-status request per second
fell from **14.45% to 6.23% CPU** after the record-cache fix, a 56.9% reduction.
The installed runtime was only observed: no restart, deploy, inspector enablement
or signal was sent to PID 92737. Only owned scratch services were stopped.

[Raw samples, summaries and reproduction scripts](clankie://evidence/sha256/3896b5288dd0af95fb17e03ab3e51c2297d630fd7cdcffb566c73c0d9a8ea950).

## Measurements

CPU is `(process CPU seconds delta / wall seconds delta) * 100`, not host load
or an average of `ps`'s smoothed instantaneous percentages. Every raw sample has
its timestamp and host load. macOS process CPU can exceed 100% across threads.

| Process/workload                |    CPU | Wall seconds | Host load1 range (mean) |
| ------------------------------- | -----: | -----------: | ----------------------- |
| Live PID 92737, 8bf44b375       | 37.04% |       181.34 | 25.14–89.02 (51.93)     |
| Source service, original reader | 14.45% |        59.81 | 11.51–14.02 (12.02)     |
| Source service, fixed reader    |  6.23% |        60.06 | 10.72–61.17 (28.46)     |
| Queue-only d17b471f8 reader     | 11.51% |        30.03 | 10.72–25.53             |
| Queue-only 8bf44b375 reader     |  9.01% |        30.00 | 12.59–15.71             |
| Queue-only fixed reader         |  2.73% |        30.00 | 11.85–14.02             |

Source-service runs sent 61 successful real operator API requests at a target
rate of one per second. The queue-only d17 run completed 28 calls; the other two
completed 30. These are bounded reproductions of the reader, not full historical
runtime replays. Source API median latency was 114 ms before and 212 ms after:
the much busier after host and governed server scheduling preclude a latency win
claim. We attribute the measured CPU directly to each process.

## Profile and source findings

- `sample 92737 30` captured the live service without an inspector or restart.
  The main thread had 18,653 samples; a 3,236-sample branch is
  `node::fs::ReadFileJob::AfterThreadPoolWork`, leading through async callbacks
  and microtasks into JIT frames. File opens, buffer decoding, JSON parsing,
  and GC appear throughout. Native sampling does not resolve those
  JIT frames to JavaScript files. This establishes file-read/callback work,
  **not a unique live caller**. No inspector listener was present. `fs_usage`
  required root and was unavailable; no credentials or privileges were changed.
- The isolated service's read-count stacks and inspector profile resolve the
  reproduced path to `IntegrationQueue.read` (original integrate.ts:192),
  `readBatches` (original :291), `stored` (:260), `status` (:195), and `snapshot`
  (:314). A census read each standalone record once to classify it, then again
  through `status`. With 838 standalone retained records that is **1,676 JSON
  reads and schema parses per request**. Warm fixed runs perform **838 metadata
  checks and no record-content reads** per request. See baseline/after read
  traces and CPU profiles; the source-idle profile is retained separately.
- The fixed `apps/clankie/src/integrate.ts:194` checks device, inode, size,
  nanosecond mtime and ctime on every read, reuses validated data only for an
  identical generation, and returns a private clone. The cache holds at most
  4,096 records. Durable writes invalidate it. The census passes its already
  read receipt into status projection, removing the duplicate read. Queue
  position, retries and active state are still computed for each request.
- Live inventory at capture was 838 records / 2,090,233 bytes: 289 pushed,
  160 failed, 228 queued, 78 interrupted, 50 cancelled, 24 conflict, 4 passed,
  1 composing and 4 held. Raw queued records do not imply 228 live jobs: status
  projects records without a running owner as interrupted.

## Commit and timer attribution

`git log -p d17b471f8..8bf44b375` on the suspects shows:

| Caller                                                              | Cadence / history                                                         | Relevant commit                                                                                                           |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Integration snapshot census                                         | Per status request; already present at d17b471f8                          | Existing cost, reproduced at both commits                                                                                 |
| Shipping census (`integrate.ts:361`, app/conversation-routes.ts:90) | Per paired-device Shipping GET, same full history reader                  | 8bf44b375 / VUH-2526 adds this consumer                                                                                   |
| Integration startup recovery (`integrate.ts:664`)                   | On queue-lock admission/startup, not a periodic timer                     | 279fb1235 / VUH-2534                                                                                                      |
| Reclamation (`integrate.ts:925`, timer :1003)                       | Startup and every five minutes, plus batch completion                     | Timer already existed at d17; 37d01c8bb and 03e0a7ad7 / VUH-2548 allow busy-queue cleanup and a durable dependency census |
| Deploy-hold expiry (`deploy-holds.ts:410`)                          | Every 15 seconds, holds.json                                              | 279fb1235 changes hold fencing; no batch-history census here                                                              |
| Waiting updates (`integration-update.ts:79`)                        | Every 15 seconds, intent first; no intent returns immediately             | 279fb1235 / VUH-2534                                                                                                      |
| Linear recovery (`captain/conversations/linear-wakes.ts:102`)       | Native poll recovery; fresh event journal scan                            | eb4682f55 / VUH-2511; synchronous journal work, not the async batch reader                                                |
| Fleet resources (`fleet-resource-runtime.ts:473`, :483)             | Refresh every 5 seconds; arbiter every second, three registry lanes       | Present in idle source trace; dozens, not thousands, of reads per 10 seconds                                              |
| Roster / presence                                                   | Shared in-flight/cursor roster projection; presence expiry uses deadlines | No added batch-history timer in this commit range                                                                         |
| Evidence / conversations                                            | Evidence metadata is SQLite; conversation journal caches by file identity | No new async history census matching this reproduction found in the range                                                 |

The canary sequence is **15.6 → 28.2 → 27.5 → 47.6 → 34.6%**, so the
canary rise is not monotonic. The old and current queue-only results do not show
a per-record algorithm regression since d17. This fix removes a measured cost
that grows with retained history and the number of readers; it does **not**
prove that VUH-2534 or VUH-2548 caused the whole live increase.

## Reproduction and validation

The source tree was rebased from 8bf44b375 onto fetched origin/main
67bed8195 before edits. Its integration source was unchanged across that rebase:
blob `3dbc0ae8f18fed1342488679802e0f649f0bb1f2`. The baseline loader supplies
exactly that original module at its normal URL; all other source, dependencies,
838-record fixture (synthetic failed records, empty repos, padded diagnostic text), API traffic, settings and state are shared with the fixed
run. The d17 loader substitutes only d17's integration module for the bounded
queue benchmark, using current dependency/schema versions.

Scratch preset: `node scripts/scratch-stack.mjs .local/vuh-2551/source --broker-operator`.
Each service ran through `clankie heavy --server -- node scripts/scratch-stack.mjs run
.local/vuh-2551/source clankie`. The preset isolates HOME, credentials, settings,
CLANKIE_STATE, peers/ports and the test fleet registry. Browser and Herdr are
disabled. The saved preload counts reads and starts/stops an inspector Session
inside **only the scratch process**; neither capture mechanism touches the live
service. Setup/traffic/preload/benchmark scripts are archived with the captures.
The owned services were stopped after capture and the scratch broker removed.

Focused verification: **3 files passed; 8 tests passed, 45 intentionally skipped**
with the named shipping/retry/cache filter. This includes the existing real Git
Shipping journey and durable retry/reclamation tests. The new real-filesystem
integration tests cover independent returned copies, in-place same-size edits
with restored mtime, atomic replacement, corruption, deletion and current shared
batch state. No mocks were added. All builds/tests/install/format commands ran
through `clankie heavy`. The landing gate is reported separately with the checked
commit and `.local/landing-gate.json`; this capture precedes that gate.

## Remaining proof

The quiet-host requirement in the issue was superseded by the assignment to work
under today's load. The source fixture does not replay the live fleet, Discord,
Linear traffic or all clients. The live native profile alone cannot establish the
fraction spent in this particular caller. **Owner deploy and a new live canary
remain required** to establish the installed result and whether it is below 10%.
No live runtime change or canary improvement is claimed here.
