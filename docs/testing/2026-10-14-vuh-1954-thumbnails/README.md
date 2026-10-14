# VUH-1954: device preview thumbnails for large PNGs

Tracks: VUH-1954 (the headless host-side thumbnail slice only; the whole issue stays open).
Code: commit `2b49114a` on base `1f912409`.

Raw files live in the evidence store (`clankie evidence fetch docs/testing/2026-10-14-vuh-1954-thumbnails`). Rendition
images and full route responses are listed individually in `evidence.json`.
Summaries, run logs, check logs and the two proof scripts are in
`small-raw.tar`.

## What changed

Paired-device `evidence_preview` used to answer `too_large` for every recorded
PNG over the 64 KiB cap. `EvidenceStore.devicePreview` now returns a complete
downscaled rendition under the same cap, after the existing record check. The
rendition is cached in memory by the source sha256. The new module is
`apps/clankie/src/evidence-thumbnail.ts`.

The bearer `GET /v1/evidence/preview/SHA256` route is unchanged and still
answers `too_large`; it was outside this slice's cleared sites.

## Decisive run: real service and relay

`real-after/` and `real-before/` come from a canonical
`scripts/scratch-stack.mjs --broker-operator` stack. Service and relay ran as
one owned runtime under `clankie heavy --server` (`stack-run.mjs`), on private
loopback ports (51657–51659 after, 63537–63539 before), never 4310 or 4321.
`real-route.mjs` did the rest:

1. Auto off was the first protected call; the preflight showed no model,
   providers, projects or devices.
2. The seven PNGs were uploaded through the store's upload API (receipt, then
   the signed PUT), which is what `clankie evidence push` calls. All were
   `applied`.
3. One device was paired with the normal offer, redeem and complete calls.
4. `evidence_preview` and `evidence_fetch` went device token → relay →
   service.
5. The device was revoked.

`real-before/` ran the base `devicePreview` (the commit's parent) on its own
fresh stack.

Fixtures are seven real clankie-app screenshots, 152–262 KB (sha256 values are
in each `summary.json`):

| fixture                  | source              | before      | after                 |
| ------------------------ | ------------------- | ----------- | --------------------- |
| 04-iphone-authored-room  | 152,789 B 1206x2622 | `too_large` | JPEG 22,214 B 353x768 |
| contact-sheet            | 165,473 B 768x6951  | `too_large` | JPEG 39,078 B 85x768  |
| iphone-direct-launch     | 199,838 B 1206x2622 | `too_large` | JPEG 24,854 B 353x768 |
| 12-ipad-small            | 210,228 B 2064x2752 | `too_large` | JPEG 25,821 B 576x768 |
| iphone-terminal-geometry | 237,361 B 1206x2622 | `too_large` | JPEG 26,655 B 353x768 |
| 12-iphone-small          | 261,577 B 1206x2622 | `too_large` | JPEG 29,924 B 353x768 |
| terminal-hierarchy-ipad  | 262,262 B 1668x2420 | `too_large` | JPEG 29,396 B 529x768 |

Results from the after run:

- **Renditions:** all seven are complete JPEGs that end with the EOI marker
  and fit under 65,536 B. First renders took 50–199 ms over the full route.
- **Cache:** a repeat request returned byte-identical JSON in 3–5 ms.
- **Originals:** each stayed fetchable through `evidence_fetch` at its full
  size, with a matching prefix. No preview response contained a URL.
- **Authorization:** no bearer → 401, a wrong bearer → 401, an unknown sha256
  → `unavailable`, and after revoking the device → 401. The before run
  answered the same for all four.

Raw route responses (`*.response.json`) and renditions (`*.thumb.jpg`) sit
beside each `summary.json`. Every rendition sha256 matches the stub run and an
earlier real run made before the HIGH-review revisions.

## Supporting evidence (not the acceptance run)

`supporting-stub/` is an earlier run before the HIGH review. It used the same
fixtures and the same HTTP dispatch route, but with `createStubCaptain`, a
seeded device and the production bearer authenticator. It shows the same
before and after answers and byte-identical renditions.

## Checks on the final source

All of these exited 0; full output is in `checks/`:

- `clankie heavy -- pnpm fmt:check` and `pnpm lint` on the changed files.
- `clankie heavy -- pnpm --filter @clankie/clankie typecheck`.
- `clankie heavy -- pnpm exec vitest run` on
  `apps/clankie/test/evidence-thumbnail.integration.test.ts` and the existing
  `evidence-device.integration.test.ts`: 5 of 5 passed.

The new integration test covers the following, with real dependencies and no
mocks:

- the real HTTP route with the production bearer authenticator;
- complete JPEG and PNG output under the cap, with the aspect ratio kept and
  both corner markers present;
- a cache hit by sha256;
- small, text and GIF answers unchanged;
- unrecorded bytes refused even when a rendition is cached;
- refusals for too many pixels, an inflate bomb and corrupt data;
- the deadline, a stalled storage read, the timeout retry window, the queue
  bound and the queue-wait timeout, and the output bound;
- the transparent-to-JPEG fallback;
- a golden table of every PNG colour type and bit depth.

## HIGH review

A native subagent reviewed the code, the trust boundary and the
original/rendition visuals twice. It found no HIGH security or data-exposure
issue: authorization is checked before any cache or blob read, and the cache
is keyed by content-verified sha256.

Fixed after review:

- busy handling: two concurrent renders and a bounded queue of 32 waiting up
  to 15 s;
- the deadline now covers the storage read;
- the colour-type golden test;
- the transparent fallback, with PNG kept only at a 512 px or larger edge;
- a timeout retry window;
- one redacted log line per sha256;
- cache accounting on overwrite;
- only `Z_DATA_ERROR` and `Z_BUF_ERROR` count as permanent refusals;
- guards and test gaps.

Visual check (the reviewer inspected seven pairs; I re-checked 12-ipad-small): the pairs are whole frames with
the aspect ratio kept and correct colours, and their text is legible. The
768x6951 contact sheet becomes 85 px wide, which is complete but too narrow to
read individual sprites; that follows from the 768 px long-edge rule.

## Gaps

- **Sticky app cache:** clankie-app caches `unavailable` for a tile until
  restart. A busy or timed-out answer can therefore stick in the app, although
  the host never caches it. This is outside the cleared sites.
- **Hung S3 reads:** on S3, a timed-out `open()` frees its render slot, but the
  hung storage request keeps running. Passing `abortSignal` to the S3 SDK
  would need `evidence-s3.ts`, which isn't cleared.
- **Bearer preview route:** it still returns `too_large` for large PNGs.
- **Untested:** live UI, real phone pairing, hosted or S3 storage,
  deployment, and worst-case CPU for a 16.7M-pixel 16-bit image.
- **Formats:** interlaced PNGs return `not_previewable`. Large JPEG and GIF
  files still return `too_large`; they are declared unsupported.
