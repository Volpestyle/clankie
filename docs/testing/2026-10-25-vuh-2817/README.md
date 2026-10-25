# VUH-2817: restored Codex status polls reload entire histories

A real live CPU profile and native thread counters identify background GC as
most of the service CPU. A production status-reader replay with frozen replies
from the current four Codex seats reproduces **55.28% CPU**. Reading native
status metadata instead reduces that replay to **2.13% CPU**, with identical
working states. This is an isolated reader result; deployed whole-service
acceptance is recorded separately on [VUH-2817](https://linear.app/vuhlp/issue/VUH-2817).

## Live attribution

The operator launched runtime `8ad233e79361742994674dba200d5e94a076116f` with
Node CPU profiling and stopped that profiled launch himself. Its profile covers
505.308 seconds around 16:37–16:45Z on 2026-10-25. This worker never restarted,
killed, signalled or deployed the live service. Native `sample` captures and
read-only kernel counters were collected without inspector attachment.

The live JavaScript profile is 69.584% idle. The Codex WebSocket callback at
`codex-app-server.ts:105` consumes 4.779% inclusive / 4.330% self, dominated by
JSON decoding; main-thread GC consumes 4.053%. These are elapsed sample weights,
not process-wide CPU percentages.

A separate 60.010-second kernel thread-counter window on normal PID 91519,
with four active seats, reconciles the process CPU:

| Thread group                | CPU, one core = 100% |
| --------------------------- | -------------------: |
| Main thread                 |              29.792% |
| Four V8 workers combined    |              43.267% |
| Four libuv workers combined |               0.882% |
| All threads                 |              73.941% |

Both native captures identify the V8 workers primarily in
`ConcurrentMarking::JobTaskMajor::Run` / `RunMajor` and
`Sweeper::MajorSweeperJob::Run`. Clipboard Tokio workers were waiting. This
establishes background GC, rather than asynchronous filesystem work, as the
large off-main cost. The main-thread profile alone cannot assign all GC to one
allocator; the controlled replay below establishes the expensive reader.

Kernel rusage reports 364,498,944 logical write bytes and 353,669,120 disk write
bytes in that window, with 69,632 disk read bytes. Writes are substantial, but
libuv CPU is under 1%; fsync/saveMeta were small entries in the JS profile.
No filesystem rewrite optimization is claimed here. A 60-second child census
observed 55 distinct direct children, including pre-existing/defunct processes;
short-lived children can be missed. Child CPU accrued 3.529 seconds, separate
from the parent's CPU. This is not an exact spawn count or an attribution of
all child work. Raw argv stays private.

Earlier passive process windows: PID 61590 used 50.883% CPU / 120.256s;
profile-enabled PID 91389 used 74.711% / 120.277s. Fleet activity and host load
changed, so these are incident observations, not matched experimental arms.
The six-seat activity/telemetry/subagent reader probe used 4.668% / 60.444s;
the five-seat probe including full transcripts used 6.466% / 60.370s. Neither
reproduced the whole alarm.

## Cause and fix

After service restart, the original launch adapter is gone. Roster enrichment
attaches `externalCodexQuestions` to surviving native workers. Its `status()`
called `thread/read` with `includeTurns: true` on every fleet projection, then
walked historical items to hydrate questions. One long-lived current seat had
78 turns and a 21,113,677-byte reply; its metadata-only reply was 5,460 bytes.
Across four current seats, full replies totalled 25,531,289 bytes versus
23,163 metadata bytes. The largest full read took 689ms versus 52ms for metadata
in one uncontrolled live read; no latency benchmark is inferred.

Status now reads `includeTurns: false` and maps the native `activeFlags`:
`waitingOnApproval` and `waitingOnUserInput` are blocked, empty flags are working,
and idle remains idle. Missing/unknown active flags and mismatched identity
refuse the observation. The exact loaded thread and native occupant checks
remain. Explicit question reads and answers still validate their fresh history;
no authority-bearing status cache or answer shortcut was added.

Separately, core/app workspace conventions already name the same Linear team,
project and label, but have different decision provenance and documentation.
The old full-record equality falsely refused that shared tracker scope.
Comparison now uses Linear routing fields while validating each original saved
file independently before effects. Patch A landed at `5f8fcf34a` with this
scope fix, metadata-only status and real error logging; it excluded backoff.

The separate backoff follow-up retains unresolved live assignments as possible
owners. Observation failures retry after 30s, doubling to a five-minute cap for
the same occupant and assignment. A still-present unreadable seat has not exited.
Before retirement without a known successor, each unresolved possible owner is
freshly resolved; a recovered owner keeps its shared issue In Progress and is
named in the handoff, while a still-unreadable owner defers tracker effects.
The daily orphan check also defers until ownership observations are complete.
Success clears the failure backoff; none of these records caches write authority.

`fleet.progress.unavailable` now uses Pino's `err` serializer and identifies the
source while retaining the original exception as its cause. The observer's
existing five-second result deadline and one outstanding read per source are
proved through a real stalled HTTP dependency; no overlapping replacement read
is introduced by a timeout.

## Controlled four-seat replay

The exact four full/metadata replies are frozen privately. A separate owned
WebSocket provider process serves their original bytes according to the native
`includeTurns` parameter. Each client arm uses production
`externalCodexQuestions`, `CodexAppServerClient`, loaded-thread checks and real
WebSockets. Only the baseline loader substitutes the original
`external-codex-questions.ts` at its normal module URL. All other source,
dependencies, inputs and cadence match. Provider CPU is excluded from the
client's `process.cpuUsage()` delta. Three warmup rounds precede measurement;
the target cadence is one four-seat round per second. Profiles are enabled in
both arms. No forced GC, model turn or live write is performed.

| 31 rounds, four seats              |    Original |   Candidate |
| ---------------------------------- | ----------: | ----------: |
| Wall seconds                       |   31.000838 |   30.999773 |
| Process CPU seconds, user + system |   17.137447 |    0.660804 |
| Process CPU                        |     55.281% |      2.132% |
| Received WebSocket bytes           | 791,456,753 |     736,839 |
| Natural RSS at end, bytes          | 700,555,208 | 228,762,392 |

This is one sequential pair on an uncontrolled shared host, not a statistical
confidence interval. It reproduces the actual current fleet's reader inputs,
not all live service traffic or its long-lived heap. The operator owns deployment
and the subsequent live steady-state CPU measurement.

## Regression evidence and reproduction

- The new real-WebSocket status integration regression transfers 11,500,252
  bytes and fails its byte budget on the original source. The candidate passes
  working, idle, both native waiting flags, unknown flags, replacement identity
  and unloaded-thread cases with under 10KB total transfer.
- Real convention files and a disposable OAuth/GraphQL provider prove shared
  Linear scope, per-file revalidation and fresh retirement during backoff.
  The original made 101 failing lookups for 101 observations; the follow-up
  makes one within the backoff window and recovers after scope repair.
- Review caught a shared-issue retirement bug in the initial backoff. Its
  real-provider regression now fails on that original change (two cases mark
  the active issue Done) and passes on the follow-up: 100 observations add no
  lookup, retirement rechecks the successor fresh, unreadable ownership defers
  effects and orphan claims, and recovery allows a final legitimate close.
  [Backoff regression and Patch A landing receipts](backoff-proof.json).
- The real HTTP progress regression times out twice, retains exactly one
  background request, observes the healthy source, recovers, and records a real
  HTTP 503 cause with message/type/stack.
- Focused checks and the root landing/review results are attached to the issue.

Every build, install, formatting command, test and bounded runtime used
`clankie heavy --`. The replay scripts and content-free summaries are archived
with this record. Original native replies, argv, and raw CPU profiles remain
private under the task worktree's `.local/vuh-2817` and the operator's
`cpu-profiles/vuh-2817-20261025T163713Z` directory. Input hashes identify those
private bytes without publishing worker content.

[Content-free measurements, regression failures and replay scripts](proof.json).
