# VUH-2379: recurring runtime CPU alarms

Issue: https://linear.app/vuhlp/issue/VUH-2379

The runtime CPU alarm (50% for 5 minutes) fired at 14:36–14:47Z, about
15:06–15:22Z and 17:04–17:11Z on 2026-10-17, with `/health` fast and no deploy
before the last one. No retained `~/.clankie/cpu-profiles` file covered those
windows (the newest is from 2026-10-14), and the service's own profile hook needs
a restart. The live runtime (PID 27133, `ea428c2b5`, started 15:06:14Z) was
therefore observed in place, 17:15–18:00Z, through the inspector opened with
SIGUSR1 (the VUH-2216 method). Every probe was removed afterwards and the
inspector was closed with `process._debugEnd`. There was no restart, deploy or
settings change.

## Result

The alarm tracks garbage-collection work that external memory forces, not main-thread work.

- **Where the CPU goes.** The process ran at about 45–65% between alarms, close
  to the 50% threshold. The main thread was only 22–33% busy over two 90–120 s
  CPU profiles, with diffuse self time. Thread times showed four V8 worker
  threads at 8 min 40 s each (about 35 CPU-minutes over 2 h 13 min), more than
  the main thread's user time.
- **Heap.** `heapUsed` was a flat 1.6 GB, with old space at 1.18 GB and large
  objects at 0.37 GB. It didn't grow over 30 minutes, so this isn't a new leak.
- **GC rate.** There were 63 mark-compacts in 120 s, one every 1.9 s, each
  marking the whole 1.6–1.8 GB heap. In a 90 s window, 18 of the 19
  mark-compacts carried flags 40 (`CollectAllExternalMemory |
SynchronousPhantomCallbackProcessing`). V8 starts one of those whenever
  external (Buffer/ArrayBuffer) memory grows about 64 MB past its last limit.
- **Correlation.** Per 15 s bucket over 10 minutes
  (`raw/correlation-1744-1754Z.txt`), process CPU followed the external-GC
  count: 16–22% with none, 84% with 8–10. It did not follow `meta.json`
  rewrites or the lead's transcript growth, which were the earlier hypotheses.
- **The allocator.** A 90 s probe recorded large-buffer allocations with their
  stacks (`raw/gc-and-buffer-probe.txt`): 1.48 GB, about 16.5 MB/s. About 97% of
  it came from `createLocalTracker`'s `readStore`, which re-read the whole
  10.3 MB `~/.clankie/tracker/tracker.json` about 1.6 times a second. The callers
  were the tracker owner loop's drain (`storeId`, `call`), project validation
  (`trackerProject`, `projectStoreId`), `prepareSeatIssueTracker`,
  `builtInBinding` and `SeatIssueKeeper.observe`. VUH-2219 had already skipped
  re-parsing byte-identical content, but every call still read the file into a
  fresh 10 MB Buffer. Four reads crossed V8's external limit and forced a full
  collection of the 1.8 GB heap.

The number of reads grows with fleet activity, because seat issue observation,
worker tracker calls and owner-loop drains all scale with the number of working
seats. It also grows with the store's size. That fits alarms that arrive with
busy fleet periods without a deploy.

## Fix

`readStore` now checks the file's version first (`dev:ino:size:mtimeNs:ctimeNs`,
the same idiom as `project-hires.ts`). It reads the file only when the version
changed, and still re-validates unless the bytes are identical. The version is
taken before the read, so a racing write is caught by the next read. ctime keeps
VUH-2219's guarantee that an in-place edit of the same size with a restored mtime
is still read and refused.

On a copy of the live store (`raw/store-read-bench.txt`), 100 `storeId()` reads
went from p50/p95 1.67/3.75 ms with 155 MB of peak Buffer growth to 0.02/0.06 ms
with none.

The regression test is `apps/clankie/test/tracker-store-read.integration.test.ts`.
It reads an unchanged multi-MB store 20 times through the real file and checks
that Buffer memory doesn't grow by a store's size. The old code failed it with
101 MB of growth against a 4.2 MB bound. The existing cross-process,
same-size-corruption case still passes.

## Not established / follow-ups

- The deployed effect on alarm frequency and process CPU needs a matched-uptime
  sample after the lead deploys.
- These smaller external churns remain, each found but not fixed here:
  - `ConversationStore.saveMeta` rewrites `global-default/meta.json` as a 14.8 MB
    pretty-printed document on every change. It holds 4,703 retained
    `inboundAcceptances` since 2026-10-06, all unbounded.
  - `worker-grants/receipts/connected-calls.json` is 7.2 MB with 10,827 receipts
    and unbounded tombstones. It is loaded about three times and rewritten twice
    on every worker MCP call.
  - The head seat's Claude transcript (48 MB) is re-parsed on every 1 s tail tick
    while the lead works. This is the `ponytail` in `herdr-watch.ts` and
    `agent-transcript`, about 170 ms per tick.
- What makes up the stable 1.6 GB heap was not attributed. That needs a heap
  snapshot, which would pause the live service.
- The server lane's "Process identity unavailable" warnings (around 14:50Z and
  17:48Z) are a separate observation path in the fleet-resources supervisor. They
  are not part of this allocation churn, and this investigation didn't establish
  their cause.

Raw profiles and samples are in `evidence.json`; small text results sit in `raw/`. The attach, probe and summarizer scripts were scratch tools and are not kept.
