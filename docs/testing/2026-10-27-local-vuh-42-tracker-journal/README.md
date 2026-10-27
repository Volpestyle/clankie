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

**Where the old write went** (CPU profile of 40 writes, 1-day store):

- re-reading, parsing and chain-checking the store after the previous write: 37%
- two whole-store `structuredClone`s: 30%
- serializing and fsyncing the whole file: 20%
- diffing every sync model: 16%
- tool logic: about 7 ms in total

Copy-on-write and in-memory reuse remove the first, second and fourth. What
remains is mostly the whole-file write.
