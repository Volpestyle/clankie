# Built-in tracker write cost at fleet volume (LOCAL-VUH-42)

What one built-in tracker write costs as the store grows, before and after
[the ADR 0226 amendment](../../adr/0226-one-tracker-tool-surface.md#amendment-writes-cost-the-change-not-the-store-2026-10-27-local-vuh-42).
Measured 2026-10-27 on James's Mac (Node 26.12, APFS), each run inside `clankie heavy`.

## Method

- **Store.** [`flows/generate-store.ts`](flows/generate-store.ts) builds a store at N days of
  fleet volume from a template.
  - The template was a scratch copy of the live `~/.clankie/tracker/tracker.json`:
    16.7 MB, 966 sync commits, 90 issues, 326 comments, 998 events, 687 receipts.
  - One day is 600 sync commits. Issues, comments, events, receipts and audit keep
    the template's proportions.
  - The template is repeated with each item's UUIDs remapped and every hash chain
    rebuilt, so the output passes the tracker's own validation at open.
  - The live store was only ever copied, never opened.
- **Timing.** [`flows/bench-writes.ts`](flows/bench-writes.ts) copies a store into an empty
  scratch directory, opens it with `createLocalTracker` in a fresh process, and
  reports:
  - **Cold open:** the first `list_issues` call (parse, validation, chain checks).
  - **Single write:** p50 and p95 of 20 `save_issue` title updates, each keyed,
    after 3 warm-up writes. Each one covers the lock, load, apply, receipt, audit,
    sync commit and durable commit.
  - **Burst:** 17 sequential keyed `save_issue` creates, the 2026-10-03 burst.
- HOME was a scratch directory throughout.

```sh
node flows/generate-store.ts --template COPY_OF_tracker.json --days 10 --out STORE_DIR
node flows/bench-writes.ts --store STORE_DIR --scratch EMPTY_DIR --writes 20
```

| Days | Sync commits | Issues | Comments | Events | Receipts | `tracker.json` |
| ---: | -----------: | -----: | -------: | -----: | -------: | -------------: |
|    1 |          600 |     56 |      202 |    620 |      427 |         8.9 MB |
|   10 |        6,000 |    559 |    2,025 |  6,199 |    4,267 |          78 MB |

## Results

| Store   | Build                          | Cold open |  Write p50 / p95 | 17 creates |     RSS |
| ------- | ------------------------------ | --------: | ---------------: | ---------: | ------: |
| 1 day   | before (`f7845f6d9`)           |     49 ms |     118 / 123 ms |      2.0 s |  1.4 GB |
| 1 day   | copy-on-write, in-memory reuse |     55 ms |       33 / 37 ms |     0.58 s | 0.56 GB |
| 10 days | before (`f7845f6d9`)           |    307 ms | 1,036 / 1,164 ms |     17.7 s |  5.5 GB |
| 10 days | copy-on-write, in-memory reuse |    352 ms |     232 / 239 ms |      3.9 s |  1.2 GB |

**Hired-worker path.** Production opens a fresh scoped backend for each hired worker's tool
call (`assertIssueWrite`), so each timed write below goes through a new instance (`--hire`). The
last column times the long-lived service instance's next read, which before re-parsed the store
after every foreign commit. Every instance in the process now shares one frozen committed
snapshot.

| Store   | Build                  | Hire write p50 / p95 | 17 creates | Service read after |
| ------- | ---------------------- | -------------------: | ---------: | -----------------: |
| 1 day   | before (`fcd07f990`)   |         129 / 142 ms |      2.3 s |              46 ms |
| 1 day   | shared committed store |           34 / 37 ms |     0.56 s |             0.7 ms |
| 10 days | before (`fcd07f990`)   |     1,060 / 1,125 ms |     18.4 s |             309 ms |
| 10 days | shared committed store |         281 / 309 ms |      4.4 s |             8.7 ms |

**Where the old write went** (CPU profile of 40 writes, 1-day store):

- re-reading, parsing and chain-checking the store after the previous write: 37%
- two whole-store `structuredClone`s: 30%
- serializing and fsyncing the whole file: 20%
- diffing every sync model: 16%
- tool logic: about 7 ms in total

Copy-on-write and in-memory reuse remove the first, second and fourth. What
remains is mostly the whole-file write.

## Part 2: the journal

The second half of the amendment appends each commit to `tracker.journal/` and keeps
`tracker.json` as a checkpoint. The stores below are the generated ones above, plus 30
and 60 days, each moved onto the journal by the real migration path. Two more flows
were used:

- [`flows/migrate-store.ts`](flows/migrate-store.ts) moves a scratch copy and compares
  every top-level record collection, and every sync commit, with the original.
- [`flows/journal-format.ts`](flows/journal-format.ts) compares the two candidate
  formats on real journal records.

`bench-writes.ts` gained `--pollers N`. It runs N `sync` subscribe long-polls on the
timed issue's group throughout the timed writes, each re-subscribing after every page,
as `list_changes` readers do.

```sh
node flows/migrate-store.ts --store STORE_DIR --scratch EMPTY_DIR
node flows/bench-writes.ts --store MIGRATED_DIR --scratch EMPTY_DIR --writes 40 [--hire] [--pollers 10]
node flows/journal-format.ts --segment MIGRATED_DIR/tracker.journal/000000000001.jsonl --scratch EMPTY_DIR
```

Raw output of every migration, bench and poller run:
`clankie://evidence/sha256/a43e1c9d3590c4986fce7090b37848d930a879bd41031f0f7af052736fee3b99`
([manifest](evidence.json)). The rollback recipe is in
[the work-items README](../../../packages/work-items/README.md#storage).

**Load.** The machine is shared with the fleet, and the 1-minute load average was 8 to
22 on 18 cores during these runs. The same store varied up to 2× between runs, so each
cell gives the range over every run, with the 60-day ranges over 4 runs per path.

### Migration

Every check passed with nothing lost: each top-level collection and field of the
checkpoint plus tail, and the sealed history segment, against the original file.

| Store     | Original | Checkpoint | History segment |   Move |    RSS | Records checked                                                                                  |
| --------- | -------: | ---------: | --------------: | -----: | -----: | ------------------------------------------------------------------------------------------------ |
| live copy |  16.7 MB |     7.9 MB |          5.3 MB | 145 ms | 0.4 GB | 90 issues, 326 comments, 998 events, 966 audit, 687 receipts, 966 sync commits                   |
| 1 day     |   8.9 MB |     5.0 MB |          3.9 MB | 103 ms | 0.3 GB | 56 issues, 202 comments, 620 events, 600 audit, 427 receipts, 600 sync commits                   |
| 10 days   |    78 MB |      45 MB |           34 MB | 735 ms | 1.1 GB | 559 issues, 2,025 comments, 6,199 events, 6,000 audit, 4,267 receipts, 6,000 sync commits        |
| 30 days   |   233 MB |     134 MB |          100 MB |  2.0 s | 2.7 GB | 1,677 issues, 6,075 comments, 18,596 events, 18,000 audit, 12,801 receipts, 18,000 sync commits  |
| 60 days   |   464 MB |     267 MB |          199 MB |  4.0 s | 4.0 GB | 3,354 issues, 12,149 comments, 37,193 events, 36,000 audit, 25,602 receipts, 36,000 sync commits |

### Writes

Before means origin/main `27f1f5ad0`, and copy-on-write means patch 1 (`450638515`).
Both were run on the single-file stores.

| Store   | Build                 |   Cold open |                                                            Write p50 / p95 |  17 creates |         RSS |
| ------- | --------------------- | ----------: | -------------------------------------------------------------------------: | ----------: | ----------: |
| 1 day   | before                |       46 ms |                                                               113 / 125 ms |       1.9 s |      1.4 GB |
| 1 day   | copy-on-write         |       51 ms |                                                                 31 / 33 ms |      0.52 s |      0.6 GB |
| 1 day   | journal               |    39–45 ms |                                                      5.0–5.3 / 5.3–11.8 ms |    83–92 ms |      0.3 GB |
| 10 days | before                |      294 ms |                                                           1,008 / 1,064 ms |      17.9 s |      5.4 GB |
| 10 days | copy-on-write         |      372 ms |                                                               220 / 245 ms |       3.7 s |      1.2 GB |
| 10 days | journal               |  184–252 ms |                                                      5.2–8.8 / 6.1–11.9 ms | 0.11–0.21 s | 0.5–0.75 GB |
| 30 days | before                |      880 ms |                                                           3,466 / 3,660 ms |      55.6 s |     11.4 GB |
| 30 days | copy-on-write         |      971 ms |                                                               746 / 806 ms |      11.0 s |      4.1 GB |
| 30 days | journal               |  616–687 ms |                                                   10.3–11.2 / 11.4–14.4 ms | 0.28–0.30 s |      1.0 GB |
| 60 days | before, copy-on-write |           — | first write fails: `RangeError: Invalid string length` in `JSON.stringify` |           — |           — |
| 60 days | journal               | 1.11–1.53 s |                                                   11.7–21.7 / 14.3–39.8 ms | 0.41–1.01 s |      1.8 GB |

The 60-day 39.8 ms p95 and 1.01 s burst came from the one run at load 20. The other three
60-day runs, at load 8 to 10, gave p95 14.3 to 24.4 ms and 0.41 to 0.55 s.

**Hired-worker path** (`--hire`: a fresh scoped instance per write, then the service
instance's next read):

| Store   | Build   |     Hire write p50 / p95 |  17 creates | Service read after |
| ------- | ------- | -----------------------: | ----------: | -----------------: |
| 1 day   | journal |             5.2 / 6.1 ms |       91 ms |             0.8 ms |
| 10 days | journal |            9.3 / 10.7 ms |      0.16 s |             8.2 ms |
| 30 days | journal |           12.9 / 15.8 ms |      0.30 s |              50 ms |
| 60 days | journal | 16.7–23.1 / 21.5–33.5 ms | 0.37–0.46 s |         129–145 ms |

The service read after a hire write no longer re-parses; at 60 days it is the
`list_issues` call itself, over 3,354 issues.

### Acceptance (LOCAL-VUH-42)

| Criterion at 1×, 10×, 60×      | Result                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| p95 single write ≤ 25 ms       | Met at 1× and 10×. At 60×: reused instance 14.3–24.4 ms at load 8–10 (39.8 ms at load 20); hired-worker path 21.5–33.5 ms. |
| p95 within 2× of the 1× figure | Not met at 60× (about 3–4×). The lead accepted the 25 ms bar; [LOCAL-VUH-47](#what-remains) follows up.                    |
| 17 sequential creates ≤ 1 s    | Met: 0.09 s, 0.21 s and 0.37–0.55 s (1.01 s in the load-20 run).                                                           |
| Cold open ≤ 2 s                | Met: 45 ms, 0.25 s and 1.1–1.5 s.                                                                                          |

### Long-polling subscribers

Ten pollers, 430 wake-ups per run, p50 / p95 over two interleaved rounds:

| Store   | 0 pollers                | 10 pollers               |
| ------- | ------------------------ | ------------------------ |
| 10 days | 6.8–7.3 / 11.7–11.9 ms   | 7.6–7.8 / 8.7–15.8 ms    |
| 60 days | 16.0–16.8 / 19.9–22.7 ms | 17.8–18.0 / 19.3–21.6 ms |

Before subscribers read the current snapshot without the store lock, each re-subscribe
queued for the lock ahead of the next write. Ten pollers then raised the p50 from
6.1 to 17.5 ms at 10 days, and from 22 to 43 ms at 60. A wake-up now costs about 0.27 ms
of CPU at 60 days, measured by profile, and copies or parses nothing.

### Checkpoint growth

The checkpoint holds no sync log. It grows with events, audit and receipts, by about
4.4 MB a day at fleet volume: 5 MB at 1 day, 134 MB at 30 and 267 MB at 60. At 90 days
that projects to about 400 MB, with a cold open of about 1.7–1.9 s on a quiet machine,
since cold open grew by about 19 ms a day here. Open still parses the checkpoint as one
string. At about four months of fleet volume that reaches V8's maximum string length
again, so retention or a streamed open has to come before then. That is recorded on
LOCAL-VUH-47.

### Format: JSONL against `node:sqlite`

500 commits of real journal records (mean 6.6 KB) from the migrated live copy, each made
durable. Two runs:

| Format                                      |     Commit p50 / p95 | Replay 500 |    Size |
| ------------------------------------------- | -------------------: | ---------: | ------: |
| JSONL, write at known end + fsync           | 4.0–5.1 / 5.2–7.9 ms |     7.5 ms | 3.30 MB |
| SQLite WAL, `synchronous=FULL`, `fullfsync` | 5.0–6.9 / 7.0–9.2 ms |     7.5 ms | 3.75 MB |
| SQLite WAL, `synchronous=FULL`, plain fsync |  0.07 / 0.11–0.13 ms | 6.7–7.0 ms | 3.75 MB |

On macOS, Node's `fsync` is `F_FULLFSYNC`, a disk cache flush. SQLite matches that only
with `fullfsync`, and at that durability it does not win. The plain-fsync row survives a
process crash but not a power loss.

### Crash and integrity proofs

These are integration tests on the real store, real processes and real `kill -9`:
[`tracker-journal.integration.test.ts`](../../../packages/work-items/test/tracker-journal.integration.test.ts).

- **Migration:** a large store moves with every issue, event, audit entry and receipt
  intact, and the whole sync history still serves cursor 0.
- **Crash between append and fsync:** a torn final line is left out, and the next
  commit, from another process, cuts it off.
- **Crash between checkpoint and rename:** sealed segments, a new live segment, the old
  checkpoint and a leftover temp file reopen with every write, then commit and
  checkpoint again.
- **Twenty `kill -9`s of a writing process mid-write,** alternating with this process's
  own writes. Every acknowledged write is present, at most the in-flight one is added,
  and a fresh process proves every chain and sealed segment. A killed holder's lock is
  aged past its 60 s stale window rather than waited out.
- **A checkpoint stopped after starting its new segment, then a restart** (review
  finding B1): the start-up checkpoint runs before any commit, and a write follows.
  The empty segment stays live, so no sealed segment is empty, and a fresh process
  opens the store with the write. Without the fix, that reopen refused the store.
- **Replay** gives the same store on every open, and a keyed retry after a checkpoint
  returns the original result.
- **A changed commit hash or sealed-segment byte** refuses the open, for a fresh process
  and for a live one.
- **Ten long-pollers** see every commit in order during a burst.
- **Cutover onto a journal-backed store, and switch-back,** keep the whole history.
  The rollback export equals the cutover backup.
- **Teeth:** dropping the torn-tail truncation, or the sealed-digest check, makes its
  test fail.

### What remains

LOCAL-VUH-47 is in Clankie Work's built-in tracker, P3, blocked by LOCAL-VUH-42. At 60 days the remaining per-write cost is
spread across passes over whole collections:

- the journal record's identity diff;
- settling the snapshot;
- the sync candidates;
- receipt and bundle lookups by key;
- GC.

Element reads on frozen arrays are 5–9× slower in V8 than on plain ones, and `slice()`
of a frozen array is 26× slower than a spread. The copies here use spreads.
