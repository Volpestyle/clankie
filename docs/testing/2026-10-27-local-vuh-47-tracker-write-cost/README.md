# Flat built-in tracker write cost at 60 days (LOCAL-VUH-47)

What one built-in tracker write costs at 1, 10 and 60 days of fleet volume, before and
after LOCAL-VUH-47. Before means origin/main `f59461d17` (the LOCAL-VUH-42 journal).
Measured 2026-10-27 on James's Mac (Node 26.12, APFS, 18 cores), each run inside
`clankie heavy`.

## Method

- **Stores.** These are the 1-, 10- and 60-day stores generated and migrated onto the
  journal for
  [LOCAL-VUH-42](../2026-10-27-local-vuh-42-tracker-journal/README.md#part-2-the-journal),
  copied without their `tracker.pre-journal-*` backups. At 60 days that is 3,354 issues,
  12,149 comments, 37,193 events, 36,000 audit entries, 25,602 receipts and 1,826
  bundles. The checkpoint is 267 MB.
- **Bench.** The unchanged
  [`bench-writes.ts`](../2026-10-27-local-vuh-42-tracker-journal/flows/bench-writes.ts),
  run plain and with `--hire`: p50 and p95 of 40 keyed `save_issue` updates after 3
  warm-up writes, then 17 sequential creates. `--hire` puts each timed write through a
  fresh scoped instance, as hired workers write, and then times the long-lived service
  instance's next `list_issues` read.
- **Runner.** [`flows/bench-rounds.sh`](flows/bench-rounds.sh) runs every store on both
  paths. It records the 1-minute load average before and after each run. HOME and XDG
  point at a scratch directory, and each run works on a scratch copy. No live store,
  keychain or settings were opened.
- **Same load.** Before and after ran interleaved, one round each, three rounds in all.
  The before build ran from a detached worktree at `f59461d17`.
- **Profiles.** CPU profiles of 120 writes on the 60-day store, both builds and both
  paths, summarized by [`flows/profile-summary.mjs`](flows/profile-summary.mjs), with
  open and read samples excluded.

```sh
flows/bench-rounds.sh before BASE_CHECKOUT STORES SCRATCH runs.jsonl 1 10 60
flows/bench-rounds.sh after  THIS_CHECKOUT STORES SCRATCH runs.jsonl 1 10 60
```

Raw runs: `clankie://evidence/sha256/1c7dc266fbafa6dd6001ca4a944a4d126f57017eb2451602dbf2ffed1bfb2a1e`
(`artifacts/local-vuh-47-bench-runs.jsonl`, [manifest](evidence.json)).
It holds a first 3-round baseline run before any change (`baseline-before`) and the
interleaved rounds (`final-before`, `final-after`). Profile summaries are in
[`evidence/`](evidence/).

**Load.** The 1-minute load average was 2.3 to 3.1 on 18 cores in the interleaved
rounds, and 3.0 to 3.5 in the baseline. That is lower than LOCAL-VUH-42's 8 to 22, and
no loaded runs were possible in this session. Each cell gives the range over three runs.

## Results

Single write, p95 in ms, interleaved rounds at load 2.3–3.1:

| Store   | Path  |    Before |   After | After ÷ after at 1 day |
| ------- | ----- | --------: | ------: | ---------------------: |
| 1 day   | plain |   5.1–5.2 |     5.2 |                      — |
| 1 day   | hire  |   4.8–5.4 | 4.9–5.4 |                      — |
| 10 days | plain |   6.0–6.1 | 5.9–6.7 |               1.1–1.3× |
| 10 days | hire  |   5.9–6.0 | 5.6–5.8 |               1.0–1.2× |
| 60 days | plain | 11.5–19.1 | 7.0–7.7 |               1.3–1.5× |
| 60 days | hire  | 16.4–20.8 | 6.7–7.1 |               1.2–1.5× |

The ratio runs from the best pairing to the worst. Even the 60-day maximum over the
1-day minimum is at most 1.5×.

| Store   | Path  |  p50 before / after | 17 creates before / after | Cold open before / after | Service read after a hired write, before / after |
| ------- | ----- | ------------------: | ------------------------: | -----------------------: | -----------------------------------------------: |
| 60 days | plain |     10.1–16.0 / 6.1 |   0.30–0.41 / 0.22–0.24 s |  1.07–1.10 / 0.95–0.97 s |                                                — |
| 60 days | hire  | 14.8–17.2 / 5.7–6.2 |   0.30–0.33 / 0.20–0.21 s |  1.07–1.11 / 0.95–0.96 s |                         127.5–131.3 / 7.3–8.0 ms |
| 10 days | hire  |   5.5–5.7 / 4.9–5.2 |        0.10 / 0.09–0.10 s |            0.18 / 0.18 s |                             5.3–5.4 / 1.5–1.7 ms |

The first baseline, three runs at load 3.0–3.5, agrees with the interleaved before
rounds. Its 60-day p95 was 11.5–12.0 ms plain and 15.7–16.2 ms hired.

**Where the 60-day write went.** CPU inside `write` per write, from the profiles:

| Build  |  Plain |   Hire | Largest remaining items (plain, per write)                                          |
| ------ | -----: | -----: | ----------------------------------------------------------------------------------- |
| Before | 5.5 ms | 7.5 ms | `storeChanges` 1.2, `syncCandidates` 1.2, `settle` 0.8, `currentBundle` 0.7, GC 1.1 |
| After  | 2.4 ms | 2.5 ms | `syncCandidates` 0.5, `recordIssueChanges` 0.3, `keyedTail` over issues 0.2, GC 1.2 |

The rest of a write is the journal append and its fsync, about 4 ms. That is what keeps
the 1-day write near 5 ms.

**`fsync` on macOS.** The issue asked whether Node's `handle.sync()` is `F_FULLFSYNC`.
Timed on this disk with 60 appends of 6.6 KB each, at load 3.4:

| Call                        | p50 / p95 per call |
| --------------------------- | -----------------: |
| Node `FileHandle.sync()`    |       4.0 / 4.2 ms |
| Python `fcntl(F_FULLFSYNC)` |       4.0 / 5.1 ms |
| Python `os.fsync` (plain)   |     0.04 / 0.05 ms |

Node's sync costs a full cache flush, not a plain `fsync`. This is timing evidence, not
a reading of the libuv source.

## What changed

- **A draft remembers what it changed.** Each collection in a write's draft knows the
  committed array it was copied from. It also knows the indices it replaced, through
  `own` or `replaceRecord`. Settling the snapshot, the journal record (`storeChanges`)
  and the sync candidates read only those records and the appended tail.
  - A draft the write left alone settles to the committed store itself.
  - A collection the write left alone stays the committed array.
  - So a write no longer copies, freezes or walks unchanged collections.
- **Lookups by key go through indexes.** Each index covers one line of committed
  arrays, and every settled commit extends it:
  - receipts by actor and key;
  - an issue's current bundle (`findLast`) and its owner asks;
  - sync models by id.
- **`list_issues` views only the page it returns.** Paging reads only ids, so the views
  are built after paging. Together with the bundle and owner-ask indexes, this took the
  60-day service read from about 130 ms to about 8 ms.
- **Cross-checks under Vitest.** Every commit compares the tracked journal record with
  the whole-store comparison, and the incremental sync diff with the full one. Every
  settled snapshot must hold only frozen records. The `tracker-copy-on-write` and
  `tracker-journal` suites pass unchanged. So does the rest of work-items: 24 files and
  93 tests, the new damage test included.

## Damaged final journal line

Each journal line now names its record's byte length (`{"syncId":N,"length":L,…}`).
Lines without a length still read, including those that a pre-framing build such as
`f59461d17` appends after framed ones following a rollback. Such a line after a framed
one must parse.

- A final line whose bytes are not a whole parseable record at that length is the
  unacknowledged tail, and open skips it. A power cut can persist the line's size and
  newline but not all of its pages.
- The same damage anywhere earlier is refused.
- A live process that acknowledged the record refuses to lose it.
- A final line that still parses but breaks a chain is refused, as before.

The issue offered a per-line length or a checksum. A checksum would make a tampered,
well-formed final line skippable. That would silently drop an acknowledged record, and
it would break the journal suite's existing refusal test.

Proof:
[`tracker-journal-damage.integration.test.ts`](../../../packages/work-items/test/tracker-journal-damage.integration.test.ts),
with real stores and fresh processes.

- A store whose final line has its full length but unwritten bytes, including a stray
  newline, opens without that record.
- The process that wrote the record refuses the store.
- The next commit from another process cuts the damaged line off.
- The same damage to the line before is refused.
- With the skip disabled, the test fails.
- A rollback to a build from before framing is covered too, after review. The last two
  records are rewritten as that build's `appendCommit` writes them,
  `JSON.stringify(record)`. A fresh process keeps both, and so does the next framed
  append. An unparseable unframed final line is still skipped. With the old
  framed-then-unframed rule, the test fails.

## Checkpoint size

`clankie doctor` now reports the built-in store's `tracker.json` against V8's maximum
string length (536,870,888), which open still parses it under. It warns at half,
268 MB. That is about two months at fleet volume of 4.4 MB a day, and about ten months at
the live rate of about 0.9 MB a day. It reads only file metadata.

Retention or a streamed open is still needed before the limit. That is LOCAL-VUH-49;
this issue only adds the warning.
