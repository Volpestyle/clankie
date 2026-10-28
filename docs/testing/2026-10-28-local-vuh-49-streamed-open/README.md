# Streamed tracker checkpoint open — LOCAL-VUH-49

Decision recorded on the issue before implementation: stream open; retain events,
audit, receipts and journal history. The JSON layout and journal remain unchanged.

## Method and baseline

All commands ran through `clankie heavy --`, with generated stores and scratch HOMEs.
The live tracker was never read. The earlier scratch datasets were deleted; the lead
confirmed regenerating a synthetic template. `flows/template.ts` uses the real API:
966 commits, 90 issues, 326 comments, 687 keyed writes. Payloads are synthetic (about
6 KB per comment); event proportions differ. The committed LOCAL-VUH-42 generator
also used by 46/47 repeats this template at 600 commits/day, remapping UUIDs and
rebuilding every hash chain. Its new `--checkpoint` option emits the existing journal
layout directly, so the baseline can measure beyond its legacy parser ceiling.
No history or receipts are omitted; the initial sealed segment contains all sync
commits, exactly as migration does.

First `list_issues` in a new process measures parse, schema validation and chain
checks. This is process-cold, not filesystem-cache-cold; caches were not purged.
Each cell is one observation, not a percentile. Old runtime is `eeeb0a624`.

| Fleet days | Checkpoint bytes |                        Old cold open | Load1 |
| ---------: | ---------------: | -----------------------------------: | ----: |
|         60 |      300,403,245 |                           1,084.8 ms | 10.16 |
|         90 |      450,219,292 |                           1,623.4 ms | 10.65 |
|        180 |      900,484,451 | Refused in 547.3 ms: V8 string limit | 11.22 |

These checkpoints are about 12.5% larger than 47's 267 MB/60-day store. This is a
capacity comparison with the recorded mix, not an exact reproduction of its timings.
The 180-day dataset is generated once and used for the bounded after/rollback proof;
no repeated 180-day benchmarks. Children have a 60-second open/proof timeout and
180-second generation timeout. Generated stores are removed after evidence capture.

## Result

| Fleet days | Streamed cold open | First durable write | Load1 |
| ---------: | -----------------: | ------------------: | ----: |
|         60 |         2,345.1 ms |             54.1 ms | 19.59 |
|         90 |         4,769.2 ms |            108.0 ms | 24.43 |
|        180 |         9,076.0 ms |            184.0 ms | 21.42 |

The 180-day process then sealed a 900,487,431-byte checkpoint in 4,392.6 ms at
sync 108001. All three sizes wrote successfully in fresh processes. Runtime was
Node 26.12.0 with an 8 GiB old-space cap. The after runs had much higher load than
the baseline, so these observations do not establish a speed ratio. Streaming is
chosen for capacity and preserved provenance; it is not a cold-open speed claim.
Reported RSS (1.81/2.58/4.79 GB) is after a second independently validated snapshot
read, not peak RSS or the footprint of a single snapshot.

The work-items suite passed 27 files / 103 tests with the existing full-diff
cross-checks enabled, including the new real-disk/fresh-process streamed checkpoint
tests. Doctor passed 25 tests; package typecheck passed. Development iterations
included a corrected fixture quoting typo, stale doctor assertion and TypeScript
closure-narrowing error. Landing verification is recorded separately.

Rollback used all work-items source files from real previous runtime `eeeb0a624`
in fresh processes, with this checkout's installed dependencies. At a smaller
journal checkpoint, old read/write and new read/receipt/write after rollback all
passed. At 900,487,431 bytes the old runtime refused `ERR_STRING_TOO_LONG` before
writing; every checkpoint and journal filename/SHA-256 matched before and after.
A subsequent new process reopened at sync 108001, retained the comment and
reconciled its keyed receipt as `applied`. All generated stores and the old-runtime
scratch source were deleted after capture.

## Scope

Large files stream arrays by entry; small files (up to 8 MiB) keep JSON.parse.
Unknown fields, Unicode, escaped strings, nested arrays/objects and duplicate keys
keep JSON semantics. Invalid syntax, truncation, trailing data and chain damage
refuse before writes. The full store still lives in memory, each record/non-array
field must fit in one string, and legacy export/cutover still assemble one string.
The unrelated FastJsonStringifier abort from a stale app in LOCAL-VUH-51 remains
unisolated; this evidence makes no claim about every response serialization path.

Raw baseline/after/rollback JSON, exact source hashes, check logs and cleanup record:
[proof archive](clankie://evidence/sha256/7d330dea3499ed7b433432650711bdbee6c8116d153f9a6f64ed4e320878b9ca).
