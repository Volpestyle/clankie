# Tracker refresh publication and checkpoint sealing (LOCAL-VUH-51)

**Final bounded full-lane replay:** one 33,328,618-byte seal; reader wait p95/max
**21.427 ms**, event-loop maximum **92.718 ms**, zero windows over 100 ms.
All 594 writes committed and all three readers agree on 57,000 models at cursor
36,839. The earlier A/B and stale-app failures remain below.

The delayed external refresh now publishes only when the shared snapshot is still
its starting snapshot. A concurrent local commit keeps its snapshot and version.
The fresh-process regression reproduces a spurious journal refusal on `e32f05e3`
and passes with the guard: external bytes validated, newer local state retained,
concurrent local write committed, zero rereads. The LOCAL-VUH-50 publication fence
is unchanged. Its regression retains the real checkpoint-read assertion; the
non-discriminating microtask-only `settledBeforeRelease` assertion was dropped.

## Current-app A/B result

Both runs use current app `ddb7b79`, the same 244-write prefill (32,836,544 bytes
against the normal 33,328,535.75-byte threshold), default budgets, original
594-write workload and a bounded full permit. No sealing code was changed.

| Metric                                    |   Fixed tracker | Base `e32f05e3` |
| ----------------------------------------- | --------------: | --------------: |
| Seal reader wait p95 / max, ms            | 21.594 / 21.594 | 22.828 / 22.828 |
| Readers / seals                           |          16 / 1 |          16 / 1 |
| Event-loop max, ms                        |         125.268 |         196.306 |
| Windows over 100 ms                       |               3 |               2 |
| Models in each app / agent / store        |          57,000 |          57,000 |
| Digest mismatches                         |               0 |               0 |
| Writes / applied receipts / audit entries | 594 / 594 / 594 | 594 / 594 / 594 |

Every >100 ms window in these runs falls outside sealing; most of its time is
unsampled. The base also exhibits them. The lead accepted this as **pre-existing,
outside sealing**, with no further attribution or new item required for this
measurement. It is not a claim that all peak latency thresholds pass. Fixed
worker request→commit p95 is 253 ms; commit→app p95/max is 89/196 ms, all 594
samples present. Both current-app runs converge; the earlier empty pool came
from stale app setup, not the CAS change. Sixteen readers share one seal event:
these percentiles describe that burst, not sixteen independent seal trials.

The final replay adds timing around the original synchronous filesystem calls
and records checkpoint reads; it does not hold or substitute IO. It reproduces
full convergence with zero checkpoint rereads, worker request→commit p95 171 ms,
and commit→app p95 87 ms. There are no >100 ms windows in this final capture.
All earlier timing windows remain in their own CPU/GC/attribution captures.
The product bytes are identical across the two fixed current-app captures.

## Proof

`flows/race.ts` opens a real journal and commits from a second Node process.
It holds a real journal `readFile` result from the external generation, commits
locally, and starts an evidence-bundle write. The real evidence store validates
its uploaded record before the validator pauses that writer. The old refresh
then finishes between that writer's draft read and append. On the base this
replaces the local snapshot and causes `A journal commit carries exactly one sync
commit`; with the guard both the metadata read and the writer retain the local
commit, and the next read performs no checkpoint reread. No fabricated snapshots
or tracker methods replace storage. The isolated child and its external writer
use scratch HOME/XDG and stores; the test removes them in `finally`.

The worker MCP regression also calls `get_cycle` with only the cycle UUID from a
hire whose default destination is Linear, verifies the returned cycle identity,
and retains zero checkpoint rereads and all existing role/scope refusals. An
unmatched opaque id now says it matched no cut-over project's record. Host
construction types and checks the optional `referenceProjects` capability;
injected trackers without it still refuse routing as `backend_unavailable`.
The work-items skill states that `repo` is operator-only and documents the
operator's per-repo bundle/run fallback limitation.

## Bounded full-lane seal replay

Uses the LOCAL-VUH-46 launcher, 60-day store generator and five-lane HTTP/MCP /
relay / headless Chrome WorkSyncPool harness. The preserved LOCAL-VUH-42 scratch
template is the generator input. Default budgets and 1.1 s lane spacing remain.
The explicit `seal` mode prefills the live journal with 32 KiB comments to just
below the normal automatic checkpoint threshold before readers bootstrap. It
then runs the original 594 small-payload writes, without lowering that threshold
or changing the product clock. It profiles CPU/GC and injects sixteen concurrent metadata readers at each actual
`sealSegment` read, after the publication fence begins. Reader durations include
all waiting through sealing, new-segment creation and snapshot publication.
Seal spans end when `startSegment` opens the next segment after framing/hash
validation. These samples are per seal, not a general request-latency percentile.

The replay has a five-second final idle; this run makes no ten-minute periodic
reader claim. LOCAL-VUH-46/50's earlier idle evidence remains unchanged. Cold
bootstrap/startup migration and posthoc full-store/digest work are excluded from
the event-loop window. This does not measure startup migration under load.
The native-pane identity adapter and unused captain are fixtures. No native
harness or full World UI is launched. Native Mac remains unexercised at its
Keychain boundary. Agent inserted projectIds are assumed as in LOCAL-VUH-46;
app/store memberships are observed; lazy body fields are consistently excluded.

```sh
clankie heavy -- pnpm install --frozen-lockfile
clankie heavy -- pnpm exec vitest run apps/clankie/test/tracker-refresh.integration.test.ts \
  apps/clankie/test/tracker-bundle-routing.integration.test.ts \
  packages/work-items/test/tracker-publication.integration.test.ts \
  packages/work-items/test/tracker-journal.integration.test.ts \
  packages/work-items/test/tracker-journal-damage.integration.test.ts
clankie heavy -- node docs/testing/2026-10-27-local-vuh-46-peak-day/flows/run.mjs \
  /absolute/clankie-app /absolute/preserved-scratch-template/tracker.json \
  docs/testing/2026-10-27-local-vuh-51-refresh/artifacts/peak-seal seal
```

Raw red/green outputs, CPU/GC profiles, timings, request logs, digest comparisons
and exact executed sources are published in the evidence manifest. The initial
cycle assertion failed because setup had not assigned any cycle; the corrected
fixture assigns its issue to the current cycle before worker measurement.

The initial stale-app replay stopped before a seal: 128 KiB worker replies hit
the existing 50,000-character model-result limit. Attempt two used larger lead
HTTP comments and aborted as described below. No result limit or role policy
was changed. Both failed attempts are retained.

## Zone OOM finding (LOCAL-VUH-49)

The second attempt enlarged only lead HTTP comments. It crossed two seals, then
Node aborted around 450/594 writes in `FastJsonStringifier<unsigned short>` with
`FATAL ERROR: Zone Allocation failed - process out of memory`. This is a product
ceiling risk, not merely a harness failure. The exact JavaScript serialization
call is unproven because the final profile was not flushed. At abort the retained
checkpoint was **294,827,623 bytes**, its current tail **29,154,121 bytes**:
**323,981,744 bytes combined**, below the ~537 MB single-string limit. All retained
journal segments totaled 299,262,986 bytes, including covered history. Last GC
reported 1981.6 (2046.1) MB → 1443.4 (1519.6) MB; old-space was requested at 8192
MiB. The host remained healthy with ~92 GB available. No product serialization or
sealing fix is claimed here.

Posted on [LOCAL-VUH-49](clankie-work://local/comment/f5f0cfe0-b2c3-4b2a-b303-5339e7baf2dd)
with [fatal output, retained sizes, source hashes and executed runner](clankie://evidence/sha256/75bc009ab505a91d74d172c9734205aafa980c5d7afd8d71d6e9e6124b2072c0).
That investigation must account for serialization/Zone allocation before
relying on the string-length limit; it should consider streamed sealing as well
as streamed opening. This attempt used the stale app, so a repeated eager
bootstrap/response is also a possible serialization source; the OOM is not
isolated to seal serialization or reproduced with current app. Neither aborted run supplies final sealing latency.

## Stale app setup diagnosis

The first captures mistakenly supplied the stale root app checkout `1f9640106`,
not the documented clean `ddb7b79` worktree. The root checkout was never changed.
`1f9640106` is an **ancestor** of `ddb7b79`; there was no revert. Sync 7 commit
`a650f572` intentionally changed eager `lazy:false` bootstrap to `lazy:true`.
The final result uses `/Users/james/dev/clankie-app-wt/local-vuh-46` at `ddb7b79`,
also the fetched app `origin/main`. The launcher now records the app revision
and hashes of the actual pool/storage sources to expose this distinction.

The complete stale-app prefill run still establishes the seal observation:
33,334,377 bytes, 16 concurrent readers, p95/max **19.816 ms**. It is not an app
convergence success: all 594 writes committed, but the app ended at zero models,
while agent/store agreed on 57,000 models at cursor 36,839. Worker request-to-
commit p95 was 978 ms; event loop max **2,558.935 ms**, 234 windows over 100 ms.
A base-product comparison against the same stale app was stopped at about
450 writes on the lead's instruction, exit 137, once provenance explained it;
no completed A/B result is claimed from that run.

A separate real-browser diagnostic observed the exact failure:
`UnknownError: The serialized keys and/or value are too large
(size=228510458 bytes, max=133169152 bytes).` The pool tried to persist a
114,255,190-character hydrated snapshot into one IndexedDB value, failed twice,
remained empty, and requested bootstrap again. The current app avoids that
trigger with Sync 7, but its generic catch still calls `publish(); schedule()`
without showing the error. That separate behavior is filed as
[LOCAL-VUH-53](clankie-work://local/issue/b06697ca-fdd4-4f07-85f3-ea819bf531d7).
[Actual error, retry requests and current source inspection](clankie://evidence/sha256/859881e8e845b44a9b4487045e4de1106b1e6883900de857a4621d3218acaeab).
No app fix or current-app injected storage failure is claimed here.

Every stale-run >100 ms window is attributed in `attribution.json`: 59 full
bootstrap model-building/cloning windows, 59 host JSON response/write windows,
58 undici JSON decoding windows, and 58 proof-relay JSON response/write windows.
The maximum includes 2,390.98 ms under `syncModels`, 170.99 ms structured cloning
and 30.06 ms sampled GC (inclusive spans overlap). None overlaps the seal span.
CPU clocks use the inspector start/stop calls' performance anchors: macOS
inspector and `hrtime` have different origins. Calibrated elapsed-time mismatch
is about 0.105 ms over 333.763 s. Sample intervals over 5 ms are marked as gaps,
not charged to the preceding leaf. These repeated bootstrap costs are a stale-
client failure, not evidence of a slow seal or a CAS regression.

## Published evidence

- [small-captures.json](clankie://evidence/sha256/d7dc12c20e2911026b63f1cca3ac9270cab8259507b8769411ed693a9985d8cd)
- [summary.json](clankie://evidence/sha256/34865ea8fa4f2cb259f5a2afff4e01fd4988d71b7e9320132d43a59844e652ac)
- [event-loop.json](clankie://evidence/sha256/7cd8f7bc987f7e741152a5dd17703626a341a1e066bc4195770cb6036e917286)
- [browser.png](clankie://evidence/sha256/0e3560a8486779c7e1125ddc060d24db075383d13e2df7757d626d7fb7563fbd)
- [sync-io.json](clankie://evidence/sha256/0ab44bbfa939031c1a2ad1ac8e64c0da1e7f84d687b401244b547a3c38063fc7)

![Final web pool: 57,000 models at cursor 36,839, ready](clankie://evidence/sha256/0e3560a8486779c7e1125ddc060d24db075383d13e2df7757d626d7fb7563fbd)
