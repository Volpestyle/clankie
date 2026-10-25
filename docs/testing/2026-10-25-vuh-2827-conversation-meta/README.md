# VUH-2827 / VUH-2817 Patch C2: retained inbound reports

The global conversation metadata snapshot contained 2,753 receipts in
10,940,227 bytes: 8,169,697 bytes were inbound acceptances (2,403 read,
348 delivered and two uncertain); folded seat history added 2.60 MB. An
ordinary report, receipt or seat event rewrote the whole file. The matched live
write attribution and connected-call fix are recorded in
[Patch C1](../2026-10-25-vuh-2827-connected-receipts/README.md).

C2 moves acceptances into immutable content-addressed buckets in each
conversation's `inbound-reports/` directory. `meta.json` commits the shard
manifest as part of the same question/report admission boundary. Changed buckets
are synced before metadata is atomically renamed and the directory synced.
Only after that commit may obsolete shards be collected. Failed preparations
never admit reports. Missing/corrupt committed shards fail closed rather than
becoming an empty inbox. Reads support legacy inline records; migration waits
for initial cutover to be durably healthy, then the next successful commit. Context reset creates independent fresh shards
before archiving the old directory.

The existing 24-hour read-report retention is preserved and applied inside the
manifest commit. Unread, delivered and uncertain payloads are never compacted.
A failed pre-rename commit preserves the original map for rollback; failures
past rename retain consumption uncertainty. Question commits and ordinary
metadata commits share the same serializer and manifest. The bounded issue
metrics reader also follows and validates committed shards within its byte
budgets. Operator guidance lives in the shipped `trace-clankie` skill.

Unchanged saves coalesce after checking file identities and durability.
Repeated transport stages and report offers no longer create fresh timestamps
and rewrites after their first evidence is persisted. The first offer/take stays
recorded; explicit acknowledgment is still required. Rollback snapshots retain
only modified delivery state, avoiding whole-ledger structured clones.

## Measurements

Owned production ConversationStore replays use the exact frozen private global
metadata, real filesystem I/O and passthrough write/fsync counters. Baseline
modules are substituted at their normal URLs; other inputs and cadence match.
Migration and first-offer warmup are outside steady-state measurement. No model
turn, live tracker write, forced GC, service restart or signal occurs. Every
runtime and check uses `clankie heavy --`.

Two workloads distinguish repeated reads from productive mutations: 60 offers
of the same already-offered report, and 60 first-time offers of distinct unread
reports, both over 30 seconds. Each offer also checks its actual durable receipt.

| Measurement, 60 operations / 30 seconds |      Original |            C2 |
| --------------------------------------- | ------------: | ------------: |
| Repeated-offer process CPU              |       19.451% |        6.677% |
| Repeated-offer CPU seconds              |      5.835505 |      2.003306 |
| Repeated-offer actual write bytes       |   656,418,180 |             0 |
| Repeated-offer natural RSS              | 538,504,152 B | 400,774,152 B |
| First-time-offer process CPU            |       20.475% |       12.466% |
| First-time-offer CPU seconds            |      6.145177 |      3.739879 |
| First-time-offer actual write bytes     |   656,557,260 |   169,714,168 |
| First-time-offer natural RSS            | 572,142,016 B | 383,702,504 B |
| First-time-offer writes / fsync calls   |        60 / 0 |     120 / 240 |

Repeated reads add no new offer/take evidence after warmup, so make no further
writes. Genuine first-time offers reduce write bytes 74.15% and measured CPU
39.1%, while adding file/directory durability. These are sequential pairs on an
uncontrolled shared host, not confidence intervals. RSS is a natural end sample,
not a retained-heap measurement; no heap dump or forced GC was used.
The metadata root remains about 2.79 MB because folded seat history is still
inline. This bounds receipt amplification; it does not attribute all service
CPU or RSS to metadata. Whole-service acceptance remains lead-owned.

## Boundary regressions and tradeoffs

Four real-store regressions extend the existing recovery suite: a >6 MB legacy
inbox migrates while compacting only 100 expired read reports and preserving
412 delivered/uncertain reports; repeated native stages and explicit offers
preserve manifest inode/mtime; corrupt/missing committed shards refuse without
replacing the inbox; pre-rename faults preserve rollback state, and post-rename
sync uncertainty retains the new admission without executing its runner.
Filesystem fault tests pass through every operation except their selected fault.
Existing separate-process abrupt-death, reset/archive and question-commit tests
remain. The issue-metrics reader retains its original source/request read budgets.

Fourteen focused suites pass 212 tests, combining the six unchanged successful
suites from the initial run with the corrected recovery/CLI pair and six routing
suites. The initial two fault probes failed because their filesystem spies did
not intercept named imports; a passthrough namespace makes the intended faults
reach the production commit boundary. No product change was needed for that.

The review follow-up restores the base's pending-question activity projection
byte for byte, including priority, full redacted prompt, stable identity,
conversation target and underlying activity pruning. The existing HTTP case
and recovery suite pass 17 tests. Absent optional receipt properties are deleted
after commit rather than assigned `undefined`; stale test imports are removed.
The full service typecheck passes its source program and all 15 test batches;
focused lint passes. The follow-up evidence binds the corrected sources and
these checks. The earlier component measurements exercise the same persistence
workload and inputs.

Durability has a measurable cost: 100 new reports through all three lifecycle
commits take 13.12 seconds, including 9.40 seconds in 1,200 fsync calls on this
shared Mac. The previous ordinary metadata writer did not sync. The existing
669-report CLI case exceeded its 30-second budget while constructing live
admissions for a historical-inbox read test. Its two large historical fixtures
now derive batch legacy rows from one real production receipt, retaining the
585/669 report counts, all real CLI/HTTP/store assertions, and the original
30-second timeout. Ordinary smaller cases still admit every report normally.
This fixture adjustment does not claim high-throughput live admission performance.

## Initial cutover and rollback

The initial-health updater can automatically restart the previous runtime. A
pre-C2 reader ignores the new manifest, sees no unread reports and can delete a
side-conversation directory. An isolated unconverted real-ledger probe confirmed
this; the separate cleanup bug is [VUH-2831](https://linear.app/vuhlp/issue/VUH-2831).
The previously approved eager-migration patch is withdrawn and must not be pushed.

Service composition now supplies the store with a cutover readiness callback.
Before readiness, metadata retains its full inline receipt map, makes no shards,
defers read compaction, and syncs inline admission commits. The callback requires
the private update journal's matching healthy target and service receipt. A
helper-launched boot also requires the exact operation, instance and PID. It
syncs the validated healthy record and parent directories before allowing the
format change. Missing, corrupt, changing or unsynced evidence leaves the legacy
layout intact. An unavailable updater during a helper-tagged boot also defers.
A fresh standalone install with no update operation has no automatic predecessor.
Once the cutover is durably healthy, the helper cannot automatically roll back;
the subsequent advisory canary is separate. The next metadata save migrates.

The actual 2,753-record private global ledger plus a separate synthetic unread
side admission was exercised through the real private journal and new store.
An owned HTTP health endpoint failed with 503; exact pre-C2 production sources
then started without conversion and read all 2,753 global records and the side
report. No directory was deleted, every full record hash matched and no runner
executed. In the healthy journal path, both conversations migrated to committed
shards while preserving all receipt payload fields. This exercises journal,
store, failed HTTP health and old-reader boundaries; it does not invoke the live
launcher or claim an end-to-end updater deployment. Permanent integration cases
also cover the wrong boot's receipt and a healthy-marker sync fault. The matching
eager-patch replay sees zero reports and deletes the side directory; deferred
migration prevents both. Four focused suites pass 52 tests; the full service
typecheck passes its source program and all 15 test batches.

The first save migrates disk layout. A pre-C2 reader does not follow shard
references. The lead must stop the service, back up the current metadata and
shards, then use the tested offline `rollback-inbound-reports.mjs` to restore
inline `inboundAcceptances` before starting a pre-C2 runtime. Convert current
records, including post-migration arrivals; never restore an older snapshot
and discard new reports. Leave shards intact for audit/recovery.

The real 10.94 MB metadata-copy proof migrates 2,753 records, admits a new
uncertain report, converts back, and loads the result with exact pre-C2
ConversationStore sources. All 2,754 records, 351 unread and three uncertain
survive with matching full-record hashes, and no report is replayed. Corrupt
shards refuse conversion without modifying the root. Scripts and the tested
single-conversation command are archived with the measurements.

C1's accepted rollback runbook and landing proof are [recorded separately](../2026-10-25-vuh-2827-rollback/README.md).

[Content-free measurements, scripts, legacy sources and regression evidence](proof.json).

[Review corrections, source bindings and verification](review-followup.json).

[Pre-healthy deferral, real-ledger old-reader replay and journal/store checks](prehealthy-proof.json).
