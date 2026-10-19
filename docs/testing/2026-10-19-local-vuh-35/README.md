# LOCAL-VUH-35: READ receipt recovery follow-ups

Issue: LOCAL-VUH-35 (built-in tracker issue `db41992f-36f9-4855-bd95-e8709ffce6f3`).
These are the review nits on the [LOCAL-VUH-13 contract](../2026-10-19-local-vuh-13/README.md).
The CLI and API contract is in [docs/cli.md](../../cli.md). Nothing is replayed, every
earlier fence is kept, and abandonment eligibility is unchanged.

## Changes

- **Route fence.** `trackerRepoForWorker` and `trackerRepoForCall` take an optional
  `TrackerRouteFence`. When the pre-lock `defaultReadFence` resolves the route, they
  register synchronous checks, and `hostFence` runs those checks again at commit, for
  reads and recovery alike. The checks cover:
  - the hire's project;
  - the repo registry and service workspace;
  - every convention file read;
  - the other repos' stores consulted for a reference.

  Each file is fenced by its stat version (device, inode, size, mtime and ctime, in
  nanoseconds), taken before its content is read. Project settings stay under the
  existing settings fence.

  Two inputs stay unfenced:
  - **The default store's own file.** Its writers hold the lock that a fenced read commits
    under. A reference it gains or loses can't move the answer unless another store
    changes, and that store is fenced.
  - **A bound built-in project's existence in that store**, which `projectReader` checks
    during routing. It is not re-checked at commit.

- **Ordinary reads stay ordinary.** Only fleet calls whose selectors fit the 1 KiB proof cap
  get `readReceiptFence` and `onReadPrepared`. Manual grants and larger selectors skip the
  native census and the READ host fences. If `defaultReadFence` throws, the read
  continues as an ordinary unclassified read instead of being refused. The failure is
  logged as `mcp.read_proof.unavailable`, and an aborted request still stops.
- **Trimmed READs stay READ.** When retention trims a settled READ's proof, the receipt
  keeps `trimmedRead`, and inspect reports `classification: "READ"` with
  `proofRetention: "trimmed"`. Abandonment is still refused with `original_read_unproven`.
  Receipts trimmed by `7939e68c8` before this change lost their snapshot and still read
  UNKNOWN.
- **`readPrepared`.** It is now set only when the worker classifies the read: every
  `onReadPrepared` the host can receive either classifies or throws. Its "After READ
  proof" comment now says so.

## Measurements (2026-10-19)

These use the LOCAL-VUH-13 harness:

- **Host.** The production `LocalFleetLink`, `WorkerMcp`, `McpHost` and built-in tracker
  on a private loopback root, run through `clankie heavy --server`, with a seeded receipt
  journal of 12,261 records.
- **Driver.** Native Claude seat `w5J:p8`, calling through the stock `fleet-mcp.mjs`
  bridge.
- **Runs.** 20 alternating rounds. "Before" is `2014e727d` with only the driver's new
  measure case; "after" is this change. Per-call timings are in [evidence.json](evidence.json).

| Call (end-to-end median, p90)          | Before       | After       |
| -------------------------------------- | ------------ | ----------- |
| eligible `get_issue`                   | 853 ms, 1176 | 757 ms, 953 |
| `get_issue` with a selector over 1 KiB | 806 ms, 1001 | 445 ms, 465 |
| `list_issues` (never eligible)         | 516 ms, 526  | 513 ms, 524 |

The oversized selector no longer pays for the census and READ fences, so it runs no
slower than an ineligible read. No issue key is over 1 KiB, so that read is always a
not-found:

- **Before:** a definite `isError` reply.
- **After:** the ordinary path's definite refusal (`possiblyDispatched: false`, as in
  LOCAL-VUH-34).

The eligible path is unchanged apart from its route checks. Its lower median is within
this harness's run-to-run spread, not a claimed speedup.

The proof host wires no route lookups, so these runs don't include the route fence's
cost. As a stand-in, one pass of stat-version checks over this machine's 19 route input
files (the registry, conventions of 18 registered repos) took 0.026 ms median (p90 0.030,
max 0.116 over 200 passes). The host runs the fence a few times per read.

## Tests

`apps/clankie/test/worker-call-receipts.integration.test.ts` (WorkerMcp level, with a
synthetic native session):

- A route change after the pre-lock fence refuses a read with `possiblyDispatched: false`,
  and refuses an abandonment without recording it.
- An oversized selector gathers no native proof.
- A failed pre-lock fence falls back to an ordinary, successful UNKNOWN read.
- A trimmed settled READ inspects as READ with `proofRetention: "trimmed"`.

`apps/clankie/test/linear-cutover.integration.test.ts` uses the routing as the service
wires it: real `work-items`, `trackerRepoForPrincipal` and project hire records. A Linear
project's worker reads the default store. When its convention switches to `builtin` after
the pre-lock fence, the read is refused with "The tracker route changed".

Negative controls, run once by hand:

- With the commit-time route checks disabled, that cutover read committed on the stale
  route.
- With the fence-failure fallback replaced by a rethrow, the fallback test failed.

## Not proven

- The route fence was not exercised natively: the proof host has no route lookups.
- Manual-grant reads skipping the census are covered by the code path only. The
  WorkerMcp tests exercise the oversized-selector branch of the same gate.
