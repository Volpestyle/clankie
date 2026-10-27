# Worker reference routing on the 60-day tracker (LOCAL-VUH-50)

LOCAL-VUH-46 exposed a worker-only reread of the 266 MB store after every
commit. This change resolves cut-over references through the tracker's shared,
validated committed snapshot and incremental metadata indexes. The before and
after captures are retained. **The peak replay fails AC3**: worker request-to-commit p95 1,902 ms and a 417.71 ms event-loop stall. Serial routing and amended AC2 pass. **Headroom remains withheld.**

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
| 60d, final incremental routing | 36.97 / 39.01 / 39.06                 | 60.36 / 63.80 / 63.81                    | 1.22 / 1.50                   | 7.17 / 9.31                      |
| 1d, final incremental routing  | 36.30 / 38.59 / 40.38                 | 60.13 / 70.38 / 72.43                    | 0.74 / 0.95                   | 5.71 / 6.19                      |

The original **within 2x of the lead** AC2 is not met: worker fixed overhead is
large relative to the lead's 1–7 ms path. After reviewing the breakdown, the lead
amended AC2 on the item to **worker serial p95 under 100 ms at 60 days, with no
store-size dependence**. The final read/comment p95 values of 39.01/63.80 ms
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

The failure is retained unchanged and reported on the item. Its cause is not
yet attributed. The lead requested a CPU-profiled replay covering every delay
over 100 ms before any further product change. This will distinguish checkpoint
serialization, receipt fsyncs, subscription fan-out and GC. No threshold or
workload adjustment is made.

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
clankie heavy --server -- node docs/testing/2026-10-27-local-vuh-46-peak-day/flows/run.mjs \
  /absolute/current-origin-main/clankie-app \
  /absolute/generated-scratch-60d-store \
  docs/testing/2026-10-27-local-vuh-50-routing/artifacts/peak-after
```

Append `serial` for the serial probe. The optional mode runs the same HTTP/MCP
wiring without launching Chrome. The seed argument also accepts a preserved
scratch template file, which the runner generates into a fresh 60-day store
using the unchanged Sync 4 generator. Never pass a live store. For the one-day
comparison, run that generator with `--days 1` in a scratch HOME/XDG environment
inside `clankie heavy`, then give its output directory to the same serial
command. All child HOME/XDG/state, settings, credential file, pairings and ports
are scratch; the governor retains its normal environment. Server-lane permits
cover the child and all helpers until teardown.

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
are labelled separately; final serial and peak captures hash the final product
sources. Node 26.12.0, 18 logical cores; load is sampled in every run. Periodic load1
ranges: original serial 2.58–2.92, snapshot-scan serial 2.79–2.94,
final 60d serial 2.37–2.71, final 1d serial 2.37–2.42. Serial samples also
record load at each completed request. This is a shared machine, without an
exclusive CPU reservation. RSS includes the proof's extra full-store snapshots
and is not a measurement of a normal service's memory footprint.

## Checks and evidence

Focused cutover, role/budget, journal-damage and copy-on-write integration
checks: 16/16 passed. Work-items typecheck passed. The focused checks cover
real disk corruption/missing-store refusal, ambiguous cut-over names, routing
fences, writes and budget boundaries. Landing gate and review pending.

[Raw captures and all serial probes](clankie://evidence/sha256/d4d96f1d9087e8eda4d6debc3647cf074980604d75f734d023a30a7539d1f542),
[peak summary](clankie://evidence/sha256/554943b4ebf74200bed2876778aee4852e16935ba83819236f5d28c8db0d247a),
[event-loop data](clankie://evidence/sha256/09b9d96ca4e51271cc26afc185bfaeb6dbaafe89308316c5406754bdc3497a33).

![Web pool at cursor 36595 with 56,512 models](clankie://evidence/sha256/149fdb03552251d5437644d9ea1910f1579e04b8f1e1f8696eb0987b4d1d1648)

The inspected screenshot shows the last pool publication, with request counter 564. Idle heartbeats do not rerender it; the final request log has 595 app calls.
The original serial/peak data packet is immutable; subsequent diagnostic runs
will be separate captures. All owned processes stopped after the first peak,
and the resource service confirmed zero permits held.
