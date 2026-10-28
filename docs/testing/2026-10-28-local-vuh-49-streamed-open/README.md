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

| Fleet days | R1 streamed cold open | First durable write | Load1 |
| ---------: | --------------------: | ------------------: | ----: |
|         60 |            2,345.1 ms |             54.1 ms | 19.59 |
|         90 |            4,769.2 ms |            108.0 ms | 24.43 |
|        180 |            9,076.0 ms |            184.0 ms | 21.42 |

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

## Review revision: hash before decoding

R1 `3f58484ae` decoded the checkpoint before comparing its digest during external
journal refresh. Hollis measured the regression and verified the decoder with
30,000 differential fuzz cases, but required restoring the existing continuation
path. R2 hashes the Buffer first, replays only the journal tail on a match, and
decodes only for a changed checkpoint or a failed continuation. Buffers do not
have the whole-string ceiling; ordinary cold opens now retain the checkpoint
Buffer while hashing and decoding it in record-sized chunks. Host snapshot
helpers still stream from the file. No decoder or journal format change was needed.

`flows/refresh.ts` uses one new 25-day synthetic generated seed and byte-identical
copies, each **126,439,182 bytes**, SHA-256
`194951de23ffeee982de02aa2c9712a34216d8d04fa18889c7211cee1e973b9c`.
Each runtime warms a reader, makes three one-comment external commits in fresh
child processes and times the parent's next `get_issue`. The before runtime is
all work-items sources archived from R1; after is R2. All ran through the heavy
queue with scratch HOME and an 8 GiB old-space cap.

| External append | R1 refresh | R2 refresh |
| --------------: | ---------: | ---------: |
|               1 |   976.0 ms |    85.8 ms |
|               2 |   946.0 ms |    92.7 ms |
|               3 |   796.5 ms |    70.9 ms |

Load1 was 12.90–13.47 before and 21.46–21.85 after. These are three observations,
not a percentile or a same-load speed guarantee. Checkpoint bytes and hash stayed
identical through both runs. The new real-process regression fails on R1 with
three checkpoint decodes and passes R2 with zero. The full work-items suite passes
27 files / 104 tests on its first R2 run; doctor and focused checks pass 28/28,
and package typecheck and scoped lint pass.

A second guard forbids any whole-buffer `toString` over 8 MiB while a fresh
backend opens the real large checkpoint. Forcing both native whole-string paths
back on makes it fail with `Whole-checkpoint Buffer.toString forbidden`. The clean
decoder was restored before R2 checks. Installed doctor now gives the public
`https://docs.clankie.bot/cli/#doctor` recovery pointer.

The 180-day dataset was **not regenerated or rerun** for R2. The earlier 900 MB
proof is R1 runtime evidence; its decoder and checkpoint/journal writer are
unchanged. R2's fresh-process guard and external-append proof cover the revised
Buffer wiring and cache path. The new 126 MB datasets and archived R1 runtime
were removed after capture.

[R2 regression, guard mutation, timings, checks and cleanup](clankie://evidence/sha256/e7025370e26e8361e66be767fba0c635cd7a2a1b175eb5eb893881a9b6a0659b).
