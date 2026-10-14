# VUH-1954: refined thumbnail bounds

Tracks: VUH-1954, the headless host-side thumbnail slice only; the whole issue
stays open.

Candidate: commit `318c0d17` (tree `170114c8`), on top of `2b49114a` and
`611735e4`, base `1f912409`. Not landed. GLOBAL owns the gate and the push.

The earlier proof in `../2026-10-14-vuh-1954-thumbnails/` is kept unchanged.
Its original-fetch check was prefix-only: one 256 KiB range per file,
recording the advertised size and whether the prefix matched. It never
reassembled or hashed a complete original, so a full-original fetch was
unproven there for all seven files.

Raw files live in the evidence store (`clankie evidence fetch` on this
folder). Renditions, route responses, the review transcripts and one failing test log
are listed individually in `evidence.json`. Everything smaller is in
`small-raw.tar`: summaries, `ownership.json`, `run.log`, the check logs,
bindings, the review texts and the proof scripts.

## What was refined

These are the lead's two blocking bounds findings.

1. `devicePreview` no longer awaits `fetch()` and an unconditional blob open
   before the thumbnail helper. It authorizes from the immutable record via
   `findRecordForBlob`, the same check `deviceFetch` uses, and takes the size
   from that record. It does this before any cache read. A large blob is opened
   only inside an admitted, deadline-bound render. A cache hit opens nothing.
2. Codec work is synchronous, so the deadline timer cannot interrupt it.
   Elapsed time is now checked after every read, parse, decode chunk, rescale
   and encode, and again before anything is returned or cached. The PNG deflate
   is raced against the deadline. The chunk walk is capped at 65,536 chunks and
   checked every 1,024. 16-bit samples expand without per-pixel closures.

## Source and check bindings

- **Source hashes:** `bindings/source-inputs.txt` holds the sha256 of every
  owned file, taken before the real run. `bindings/commit-binding.txt` shows
  the committed bytes match them.
- **Final checks:** all exited 0; full logs are in `checks/final/`:
  - `clankie heavy -- pnpm fmt:check` and `pnpm lint` on the owned files;
  - `pnpm --filter @clankie/clankie typecheck`;
  - `pnpm exec vitest run` on the thumbnail and evidence-device integration
    tests: 8 of 8 passed in 9.3 s.
- **Earlier failures, kept:** `checks/earlier-failures/` holds the failing runs:
  - one where the job reported exit 0 although the tests had failed, because
    the status came from `tail`;
  - a shadowed-variable TDZ bug;
  - a single-slot fixture after the concurrency change;
  - a wrong PNG/JPEG expectation in a costliest-raster case.
- **Costliest-raster measurement** (`checks/costliest-measurement.log`):
  16.7M-pixel 16-bit RGBA, Paeth on every row. Under shipped limits it
  rendered in 923 ms, with at most 53 ms between deadline checks. A 1 s
  deadline timed out at 1002 ms, and a 300 ms deadline at 302 ms.

## Decisive run: real service, relay and pairing

`real-refined/` is a canonical `scripts/scratch-stack.mjs --broker-operator`
stack on private ports 50864–50866, never 4310 or 4321.

**Ownership.** Service and relay were children of one owned runner under a
single `clankie heavy --server` permit (`stack-run.mjs`). The runner was PID
39086; it started service 40690 and relay 42964, which listened as 40691 and 42967. Both stayed descendants of the governed runtime for its whole life. The
server lane had no second free slot. `ownership.json` records:

- the ports before, during and after the run;
- the PIDs and parent PIDs;
- the exit codes: relay 1, service 143 after SIGTERM.

**Run steps** (`real-route.mjs`):

1. Auto off came first; the preflight showed no model, providers, projects or
   devices.
2. Seven clankie-app PNGs (152–262 KB) went in through the store's upload API.
   All were `applied`.
3. A device was paired with the normal offer, redeem and complete calls; the
   relay it got was the preset's.
4. `evidence_preview` and `evidence_fetch` went device token → relay → service.
5. The device was revoked.

**Results:**

- **Thumbnails:** all seven are complete JPEGs that end with the EOI marker,
  22–39 KB, with a 768 px long edge. They are byte-identical to the earlier
  runs.
- **Speed and cache:** first renders took 50–188 ms. Repeat requests were
  byte-identical and took 3–4 ms.
- **Originals:** every range of each original was fetched, reassembled and
  hashed. Size and sha256 match for all seven; the 262,262-byte file took two
  ranges.
- **Authorization:** no bearer → 401, wrong bearer → 401, unknown sha256 →
  `unavailable`, after revoke → 401. No preview contained a URL.
- **CPU enforcement:** the governed wrapper repeatedly reported
  `Server CPU observation unavailable; CPU enforcement degraded, server
resumed: Process identity unavailable`. The full lines are in `run.log`.
  This run is therefore not evidence of zero CPU use or of hard CPU-limit
  enforcement.
- **Teardown** (`bindings/teardown.txt`): all five PIDs are gone, all three
  ports are free, the scratch root and its `credentials.json` broker were
  removed, and no lease of mine is left.

## Supplemental controlled tests

These are not the decisive run. The integration tests use a real HTTP server,
a real SQLite store and real codecs, but some are deliberately controlled:

- a seeded device with `createStubCaptain` and the production bearer
  authenticator;
- a never-settling `open` callback for the stalled-read case;
- an injected clock for the deadline checks;
- a blob store wrapped to count opens.

They show:

- record authorization comes before the cache, using unrecorded bytes that
  already have a cached rendition;
- one blob open per miss and none per hit;
- refusals for the pixel limit, an inflate bomb and corrupt data;
- the queue and output bounds;
- a rendition finishing past the deadline at its final post-encode check is
  discarded and not cached;
- the costliest supported raster finishes inside the deadline: 16 px blocks run
  the full ladder to `too_large`, and 256 px blocks give a complete PNG;
- every PNG colour type and depth decodes to the right pixels.

## HIGH reviews (native subagents)

- **First reviewer** (`reviews/high-review-{1,2}.md` plus its transcript),
  covering the original candidate: no HIGH security or data-exposure issue. Its
  findings were fixed before `2b49114a`.
- **Second reviewer, independent of the first**
  (`reviews/independent-review-{1,2,3}.md` plus its transcript), covering this
  refinement:
  - lead finding 1 is fixed;
  - lead finding 2 is fixed;
  - its final pass says nothing HIGH or MEDIUM remains.

  Its M and L items were fixed:
  - a stream leak between open and read;
  - the `parsePng` chunk loop;
  - the test proofs;
  - the LCG precision;
  - the post-open cancel.

## Gaps

- **S3 cancellation:** a timed-out `open()` frees its slot, but a hung storage
  request keeps running in the background. Oren owns the separate
  `EvidenceBlobStore.open(sha256, abortSignal?)` seam. This candidate threads
  no signal until that seam has landed.
- **Optional record lookup:** `findRecordForBlob` is optional on the metadata
  interface, so a backend without it fails closed with `unavailable`. The
  interface is outside this slice's sites.
- **Level-6 deflate:** transparent PNGs are slightly larger, so a borderline
  image may step down an edge or flatten to JPEG.
- **Chunk cap:** the 65,536-chunk cap could refuse unusual valid files that use
  tiny IDAT chunks.
- **Load sensitivity:** the costliest-raster tests must finish inside 5 s, so
  they could fail on a heavily loaded machine.
- **Not covered here:**
  - the app's sticky `unavailable` cache, which is filed separately;
  - the unchanged bearer preview route;
  - live UI, real phones, hosted or S3 storage, and deploy.
