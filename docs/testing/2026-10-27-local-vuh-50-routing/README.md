# Worker reference routing on the 60-day tracker (LOCAL-VUH-50)

LOCAL-VUH-46 exposed a worker-only reread of the 266 MB store after every
commit. This change resolves cut-over references through the tracker's shared,
validated committed snapshot and incremental metadata indexes. The before,
intermediate and final captures are retained. Final acceptance
passes: worker request-to-commit p95 **110 ms** (target <250 ms), event-loop
maximum **81.78 ms**, zero delays over 100 ms. Serial p95 is **38.31/63.61 ms**
for reads/comments at 60 days, with no store-size growth at one day. All
LOCAL-VUH-46 checks pass. The earlier failures remain below. The lead decides
milestone headroom after review and landing.

## Change and boundaries

`mcp-host.ts` routes a worker's referenced `linear_*` calls through
`cutoverRepoForReferences`. Previously, `builtInRecordProjects` keyed its cache
on the checkpoint/journal version and called `readTrackerStoreSnapshot` after
any commit. That reparsed all checkpoint and journal content, even when the
tracker already held the exact committed snapshot.

The host now calls the backend's host-only `referenceProjects`. It checks the
store's current file/journal generation and uses the committed snapshot shared
by all backend instances. Ordinary same-process commits update this snapshot
without rereading the checkpoint. External edits/replacements still trigger
validation; missing or damaged stores refuse without seeding. Routing retains
case-insensitive references, issue aliases, duplicate-reference ambiguity and
project scope checks. No new public tool or setting is introduced.

Reference lookup uses the existing committed-array key indexes, now able to
index several aliases per record. Settling extends indexes by appended records
when replacement records retain their keys. A reference rename, deletion or
reordering starts a fresh index for that collection; an unrelated event or audit
commit does not. Historical arrays retain valid positions. The first lookup
builds metadata indexes, not another store snapshot.

A second window appeared under concurrency: a metadata reader could see bytes
from this process's append while fsync was pending, before `shared.current` had
been updated. It mistook that generation for an external change and reread the
checkpoint. A publication fence now makes metadata readers wait from actual disk
dispatch until the shared snapshot is published, or until the write fails. It
starts after authorization callbacks, which may themselves read metadata, and
releases in `finally`. Migration and checkpoint publication use the same fence.
External-generation checks remain in place after waiting.

The retained real-disk race probe reproduced **24 checkpoint rereads in 24
concurrent writes** before the fence (12 routing and 12 identity reads); the
same probe records **zero in 24** after it. The persistent HTTP/MCP harness's
`race` mode also records zero in 24. The integration regression holds the real
journal fsync while both readers arrive, checks a reader arriving at durable
confirmation, injects an append EIO with waiting readers, proves recovery, and
checks external-process commits plus damaged journal/checkpoint refusal. It
checks authorization callbacks can read without deadlock and every waiter is
released, including on failure. Existing journal, rollback and damage tests
are unchanged.

An initial in-memory scan removed the checkpoint reparse but took 4.9 ms at
60 days versus 0.2 ms at one day. The final incremental version removes that
remaining scan. Both intermediate and final serial captures are preserved.

The [LOCAL-VUH-46 proof boundaries](../2026-10-27-local-vuh-46-peak-day/README.md#method-and-boundaries)
carry forward: real HTTP host/relay, scratch signed pairing, unmodified app
WorkSyncPool/IndexedDB in headless Chrome, and an agent `list_changes` reader.
The fixture uses real worker MCP sessions, hires, routing, budgets and receipt
stores, with a test native-pane identity adapter and unused stub captain.
No native harnesses are launched. The full World UI and evidence-sheet readers
are not exercised. Mac native client not exercised (Keychain/owner-prompt
boundary). The agent assumes insert `projectIds` because `list_changes` omits
them; app/store memberships are observed. Lazy bodies are excluded consistently
from model digests. No owner HOME, live tracker, broker, Keychain or pairing is
opened by the proof.

## Serial comparison

Each role/operation has 20 real HTTP request/response samples, alternating
worker and lead order. Every measured call immediately follows an untimed lead
comment commit. Both paths are warmed first. Worker calls pass through the real
MCP endpoint, confirmed hire and scoped tracker; lead calls use the HTTP tracker
endpoint and carry no worker receipt persistence. This is not an in-process
lead timing comparison. `serial.json` retains every sample and its machine load.

| Store / code                   | Worker get_issue p50 / p95 / max (ms) | Worker save_comment p50 / p95 / max (ms) | Lead get_issue p50 / p95 (ms) | Lead save_comment p50 / p95 (ms) |
| ------------------------------ | ------------------------------------- | ---------------------------------------- | ----------------------------- | -------------------------------- |
| 60d, original routing          | 886.19 / 1356.01 / 1501.97            | 910.55 / 1219.15 / 1317.06               | 1.19 / 1.39                   | 6.97 / 7.20                      |
| 60d, snapshot scan             | 41.17 / 43.96 / 44.07                 | 65.36 / 68.18 / 73.05                    | 1.21 / 1.32                   | 7.08 / 8.10                      |
| 60d, incremental, before fence | 36.97 / 39.01 / 39.06                 | 60.36 / 63.80 / 63.81                    | 1.22 / 1.50                   | 7.17 / 9.31                      |
| 1d, incremental, before fence  | 36.30 / 38.59 / 40.38                 | 60.13 / 70.38 / 72.43                    | 0.74 / 0.95                   | 5.71 / 6.19                      |
| 60d, final fenced routing      | 36.30 / 38.31 / 39.07                 | 61.22 / 63.61 / 64.39                    | 1.23 / 1.43                   | 7.07 / 8.92                      |
| 1d, final fenced routing       | 36.06 / 38.88 / 40.72                 | 61.83 / 67.35 / 69.16                    | 0.73 / 0.97                   | 5.82 / 7.26                      |

The original **within 2x of the lead** AC2 is not met: worker fixed overhead is
large relative to the lead's 1–7 ms path. After reviewing the breakdown, the lead
amended AC2 on the item to **worker serial p95 under 100 ms at 60 days, with no
store-size dependence**. The final read/comment p95 values of 38.31/63.61 ms
meet that bound; the one-day comparison isolates the fixed receipt cost. The
original ratio result is retained here. Peak latency and stall thresholds were
not changed.

### Remaining worker time

Serial-only instrumentation times the original backend methods and
`DurableReceiptStore.save/load/read` without replacing their work. A Node CPU
profile identifies the synchronous fsync stacks. Instrumentation is disabled
in the peak replay. Totals below are median sums of timed spans within each
worker request. They overlap backend calls and must not be added to backend
call time. Request boundaries use millisecond timestamps, so sub-millisecond
edge attribution is approximate; the raw spans and CPU profiles are retained.

| Stage                | 1d get_issue / save_comment (ms) | 60d get_issue / save_comment (ms) |
| -------------------- | -------------------------------- | --------------------------------- |
| Reference routing    | 0.052 / 0.072                    | 0.051 / 0.054                     |
| Worker receipt saves | 32.38 / 49.77                    | 31.85 / 48.57                     |

There are three worker receipt saves per read and four per comment in this
probe. Receipt saves write immutable shards and a manifest, fsync each file,
and fsync their directories. The CPU profile places these in worker admission,
dispatch and settlement. These short synchronous durability operations do
block the event loop while executing; their per-call cost is similar at 1d and
60d, unlike the removed whole-store parse. This proof does not remove or bypass
receipt durability or weaken dispatch fences. Other time includes HTTP/MCP,
current hire/project/convention checks, and the tracker operation itself.

## Peak replay

The final fixed bounded full-lane capture (`artifacts/peak-final`, `profile`
mode) uses the same five concurrent lanes, 1.1 s spacing, real default budgets,
17-create burst and 10-minute idle. CPU/GC profiling remains enabled as in the
preceding full-lane failure; the workload and thresholds were not tuned.

| Check                                       | Final observed result                                                                                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LOCAL-VUH-50 AC1                            | In-process indexed routing; zero checkpoint rereads in 24 concurrent writes; external changes validated/refused; regression red before fence, green after                                   |
| LOCAL-VUH-50 amended AC2 (item criterion 4) | PASS: worker serial p95 38.31 ms read / 63.61 ms comment at 60d; 38.88 / 67.35 ms at 1d. Original ratio criterion 2 is superseded by the lead amendment                                     |
| LOCAL-VUH-50 AC3, request to durable commit | PASS: workers n=459, p50 50 / p95 110 / max 378 ms; lead n=115, p50 13 / p95 33 / max 67 ms                                                                                                 |
| LOCAL-VUH-50 AC3, event loop                | PASS: maximum 81.78 ms, zero delays over 100 ms across traffic, convergence and all idle; 70,928 interval samples                                                                           |
| Workload                                    | 594 writes, 75 creates, 840 events; 17-create burst 1,075 ms; traffic 138,347 ms                                                                                                            |
| LOCAL-VUH-46 AC1                            | 594 applied receipts, 594 audit entries, 594 unique write keys and requests; 20 discarded replies reconciled, zero derived resends                                                          |
| LOCAL-VUH-46 AC2                            | All three readers have 56,512 models, zero digest mismatches, cursor 36,595; agent insert projectIds assumed                                                                                |
| LOCAL-VUH-46 AC3                            | Commit to app pool p95 83 / max 152 ms, 594 samples, none missing                                                                                                                           |
| LOCAL-VUH-46 AC4                            | Zero periodic reads; one app bootstrap and 596 held subscriptions; one agent snapshot and 622 list_changes requests (620 settled reader pages, one head lookup, one pending reader request) |
| LOCAL-VUH-46 AC5                            | Zero role/budget refusals; rolling-minute worker write maxima 54/54/53/53 of 60; lead 56, exempt                                                                                            |
| Idle and machine load                       | Complete 600 s idle, 16:20:06.203–16:30:06.203 UTC; reported idleMs 610,509 includes posthoc capture. 153 load samples, load1 1.08–6.40                                                     |

All final owned processes stopped, and the resource service confirmed zero
heavy, light or server permits held after teardown. The maximum worker latency
is still reported even though the acceptance bound is p95. The web screenshot
is the last pool publication; idle subscription heartbeats do not rerender its
request counter. The request log is the authority for final counts.

### First unchanged capture

First unchanged capture (`artifacts/peak-after`), five concurrent lanes and
1.1 s spacing with real default budgets:

| Check                               | Observed result                                                                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workload                            | 594 writes, 75 creates, 840 events; 17-create burst 5,776 ms; traffic 179,802 ms                                                                                                            |
| LOCAL-VUH-50 AC3, request to commit | **FAIL**: workers n=460, p50 61 / p95 1,902 / max 4,241 ms (target p95 <250 ms); lead n=114, p50 17 / p95 616 / max 1,398 ms                                                                |
| LOCAL-VUH-50 AC3, event loop        | **FAIL**: maximum 417.71 ms; 240 delays over 100 ms, 238 in traffic and two in idle                                                                                                         |
| LOCAL-VUH-46 AC1                    | 594 applied receipts, 594 audit entries, no duplicate keys; 20 discarded replies reconciled; zero derived mutation resends                                                                  |
| LOCAL-VUH-46 AC2                    | All three readers have 56,512 models, zero digest mismatches, cursor 36,595; agent insert projectIds assumed                                                                                |
| LOCAL-VUH-46 AC3                    | Commit to app pool p95 183 / max 816 ms, 594 samples, none missing; no role/budget refusals                                                                                                 |
| LOCAL-VUH-46 AC4                    | Zero periodic reads; one app bootstrap plus 594 held subscriptions; one agent snapshot plus 613 changes requests (611 reader pages settled, one head lookup and one pending reader request) |
| Idle and load                       | Complete 600 s idle, 15:29:39.079–15:39:39.079 UTC; reported idleMs 615,069 includes posthoc capture. 162 periodic load samples, load1 1.45–6.07                                            |

### Attribution and retained failures

The two server-lane captures contain a governor artifact as well as the product
race. Server CPU repayment pauses the owned process group. The external native
observer recorded the exact service PID 30877 in macOS `SSTOP` from
15:51:04.750958 to 15:51:04.944807 UTC (193.85 ms). This overlaps 192.04 ms of a
209.63 ms timer delay and a 214.38 ms CPU sample gap. No signals were sent to
that service by the proof. The supervisor does not log routine pause/resume
pairs; the retained process-state log supplies that observation. The first
`ps` observer was replaced with a no-fork native observer after its own
supervisor reported degraded CPU census; the service's supervisor stayed active.
No governor settings were changed or bypassed.

The CPU-profiled server run (`peak-profile`) recorded worker p95 1,279 ms,
maximum timer delay 412.22 ms and 190 delays over 100 ms. All 190 windows have
sample, GC and gap attribution. Of these, 85 were at least 75% unsampled gaps;
only the observed idle window has direct `SSTOP` evidence. Other windows include
about 9.54 s of active hashing below `refresh`; a sample gap is not charged to
the last CPU leaf. The checkpoint inode, size and mtime stayed unchanged for
the entire run, ruling out checkpoint rewrites in this capture. The live
journal was 3,732,326 bytes, below its roughly 33 MB checkpoint threshold.

The first bounded full-lane run (`peak-full`), with no publication fence,
removed the governor artifact but **still failed**: workers n=457, p50 49 /
p95 432 / max 2,919 ms; lead n=117, p50 12 / p95 70 / max 1,202 ms. All three
remaining delays over 100 ms are attributed: 104.30 ms overlaps a 113.62 ms GC;
384.12 ms contains 386.88 ms of checkpoint hashing under `refresh`; 172.54 ms
contains `freezeRecords` (61.28 ms), `readJournalTail` (35.60 ms),
`replayVerified` (19.46 ms) and a short GC. Neither reparse window contains a
large sample gap. The direct 24/24 race probe isolated the shared-publication
cause before the fence was applied. This run kept the same 594 writes and
840 events, all LOCAL-VUH-46 criteria passed, and its complete 10-minute idle
was 16:03:08.809–16:13:08.809 UTC. It remains an immutable failing capture.

CPU profiles use 1 ms samples. The analyzer aligns V8 absolute uptime with
Node's continuous clock using the native clock offset and verifies both
captured inspector start/stop brackets. Calibration, every window and the
exact analysis/observer source are in the diagnostic packets. This separates
sampling gaps, GC and observed suspension from active product stacks; it does
not claim a CPU sample proves every microsecond's cause.

The added 10 ms event-loop interval records callback lateness beyond its nominal
interval. It runs continuously from the first traffic request through
convergence and the complete idle window. Cold startup/bootstrap and the
proof's own posthoc full-store reads and model digests are excluded. The raw
file records all delays over 5 ms, the maximum, and every delay over 100 ms.
This measures this service process, not Chrome's event loop or World rendering.

`request-commit.json` matches non-lost writes to the backend's durable
`effectConfirmed` time, preserving the same request/commit definition used in
the LOCAL-VUH-46 review. Lost-reply samples remain in `writes.json`; receipt
reconciliation makes their response duration different, so they are excluded
from these worker/lead latency groups. `requests.json` derives mutation
resends from observed write requests and unique keys, replacing the old literal.

## Reproduce

Use this checkout based on core main `052297c0b4861a9478f458ee135430bdf1ee6082`.
The separate app worktree remains clean at its freshly fetched origin/main
`ddb7b79dd67861c7b1dc66ede561ad84043af4f8`. It needs no build/install for this
narrow source bundle. This runner requires Google Chrome at
`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.

```sh
clankie heavy -- pnpm install --frozen-lockfile
clankie heavy -- node docs/testing/2026-10-27-local-vuh-46-peak-day/flows/run.mjs \
  /absolute/current-origin-main/clankie-app \
  /absolute/generated-scratch-60d-store \
  docs/testing/2026-10-27-local-vuh-50-routing/artifacts/peak-final profile
```

Replace `profile` with `serial` for the serial probe, or `race` for the 24-write
concurrent metadata-read probe. These modes use the same HTTP/MCP wiring
without launching Chrome. `profile` runs the unchanged peak plus CPU/GC
measurement; omitting the mode runs the peak without CPU sampling. The seed argument also accepts a preserved
scratch template file, which the runner generates into a fresh 60-day store
using the unchanged Sync 4 generator. Never pass a live store. For the one-day
comparison, run that generator with `--days 1` in a scratch HOME/XDG environment
inside `clankie heavy`, then give its output directory to the same serial
command. All child HOME/XDG/state, settings, credential file, pairings and ports
are scratch; the governor retains its normal environment. The bounded full-lane permit covers the child and all helpers until teardown. Latency and event-loop measurements must not use `--server`: its CPU repayment suspends the process (`SSTOP`) and appears as product stalls.

The 60-day seed has 3,354 issues, 12,149 comments, 37,193 events, 36,000 audit
entries, 25,602 receipts, 1,826 bundles and a 266,628,286-byte checkpoint.
The one-day seed has 56 issues, 202 comments, 620 events, 600 audit entries,
427 receipts, 30 bundles and a 4,985,633-byte checkpoint. Both derive from
LOCAL-VUH-42's preserved scratch template, not the live store.

`sources.json`, written before each child starts, hashes the exact runner,
launcher, browser, fixture and two product source files read for that run.
No relocation occurs. The baseline serial run predates this hash capture;
its product files were restored from main `052297c0b` for the run, then the
owned fix was restored from `.local` copies. Intermediate snapshots and scans
are labelled separately; `serial-fenced-*`, `race-final` and `peak-final` hash the final product
sources. Historical `peak-after` matches commit `ee61d5d69`; `peak-profile` and
`peak-full` match `ed18686e9`. Later diagnostic `race` mode and the launcher
comment did not change their workload. The final product files are byte-identical
across the final serial, race and peak captures. After capture, the landing
typecheck required a type-only `TrackerToolBackend & Pick<LocalTrackerBackend, "referenceProjects">`
assertion at the host factory seam. Its emitted JavaScript is byte-identical
to the captured source (esbuild 0.28.1); the [source and comparison proof](clankie://evidence/sha256/53c2aaeabce5a163882ab1b486b64f7829749cb93554776ce5267dcb515aba65)
retains both source hashes. The other five captured files are unchanged.
Node 26.12.0, 18 logical cores; load is sampled in every run. Periodic load1
ranges: original serial 2.58–2.92, snapshot-scan serial 2.79–2.94,
pre-fence incremental 60d serial 2.37–2.71 and 1d 2.37–2.42;
final fenced 60d 4.88–5.13 and 1d 4.81; first full-lane peak 2.35–7.21. Serial samples also
record load at each completed request. This is a shared machine, without an
exclusive CPU reservation. RSS includes the proof's extra full-store snapshots
and is not a measurement of a normal service's memory footprint.

## Checks and evidence

Focused cutover, role/budget, journal, journal-damage and copy-on-write integration
checks after the fence: 24/24 passed. The added publication regression fails on pre-fence `ed18686e9` with two
checkpoint rereads and passes on the final source (logs retained). Work-items typecheck passed. The focused checks cover
real disk corruption/missing-store refusal, ambiguous cut-over names, routing
fences, writes and budget boundaries. Landing gate and review pending.

[Final full-lane capture, red/green logs and exact executed sources](clankie://evidence/sha256/68f7b69258593772b4962d7e16f596beb97bb4c8f01b4739de196abf6299310a),
[final summary](clankie://evidence/sha256/725b8aded354e037b8d9cc8a92f1a4bd57a1be1afbfb1cb4470a84afcd8ddfad),
[final event-loop samples](clankie://evidence/sha256/0078e1b72e01d07f707d100dafa8a498aed5f44f7142227df12862293203f213),
[final CPU profile](clankie://evidence/sha256/9d950b50add083c9ba1727e80b84d5970ed5cd8293e8b693a5d9692e5cc83443),
[final model digests](clankie://evidence/sha256/717b021fefab09b70fe40c8903db548e8597f55615a216784691b77e60698507).

![Final web pool at cursor 36595 with 56,512 models](clankie://evidence/sha256/dd2ccd48d11bc1210d563e1236c12b1276bb39cd6beceea75c52053b73a1a0e2)

[Governor diagnosis, native pause logs and analysis source](clankie://evidence/sha256/37d09984e69e702903167ee5f3cac1d2cd705abe867cc252a34500088bb628a0),
[all 190 profiled server-lane windows](clankie://evidence/sha256/966f91081ba6c80fe7d541a4ddc666114b3b90206613a2f48c53c4b574344937),
[pre-fence full-lane CPU profile](clankie://evidence/sha256/e71289c3436fd3a4674588277667c996fe5f1f0fe9acd675f9d0c4b6b90a84b0).
The final packet contains the three full-lane failing windows and both race probes.

[Raw captures and all serial probes](clankie://evidence/sha256/d4d96f1d9087e8eda4d6debc3647cf074980604d75f734d023a30a7539d1f542),
[peak summary](clankie://evidence/sha256/554943b4ebf74200bed2876778aee4852e16935ba83819236f5d28c8db0d247a),
[event-loop data](clankie://evidence/sha256/09b9d96ca4e51271cc26afc185bfaeb6dbaafe89308316c5406754bdc3497a33).

![Web pool at cursor 36595 with 56,512 models](clankie://evidence/sha256/149fdb03552251d5437644d9ea1910f1579e04b8f1e1f8696eb0987b4d1d1648)

The first screenshot shows request counter 564; its completed log has 595 app
calls. The final screenshot shows 566; its completed log has 597 app calls.
Idle heartbeats do not rerender the last pool publication.
The original serial/peak and diagnostic packets are immutable; the final
packet is separate. The committed evidence manifest links all 71 objects. All owned processes stopped after each completed run. The final resource
snapshot records zero permits held. After landing, the worker will remove its
scratch stores/profiles and local capture copies; the published evidence remains.
