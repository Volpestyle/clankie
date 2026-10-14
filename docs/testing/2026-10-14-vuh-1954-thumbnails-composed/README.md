# VUH-1954: thumbnail deadline composed onto the S3 abort seam

Tracks: VUH-1954, the headless host-side thumbnail slice only; the whole issue
stays open.

The composed candidate is commit `706e879b` (tree `6ad76b31`) on `main`
`cc281e21`. That base includes Oren's landed abort seam, `ba47c2d1`. Not
landed: GLOBAL owns the gate and the push.

The owned commits were rebased with their files byte-identical. The earlier
candidates stay as local tags `vuh1954-precompose-*`:

- `2b49114a` and `611735e4`: the first candidate and its proof;
- `318c0d17` and `0d798ad7`: the refinement and its proof, accepted for
  composition.

Their proof folders are unchanged:

- `../2026-10-14-vuh-1954-thumbnails/` has a prefix-only original check;
- `../2026-10-14-vuh-1954-thumbnails-refined/` has full originals.

The only new product change is that the thumbnail render passes its deadline
signal to the storage read. The helper's `open` callback receives the signal,
and `devicePreview` calls `blobs.open(sha256, abortSignal)`. Oren's interface
and S3 files were not edited.

Raw files live in the evidence store (`clankie evidence fetch` on this
folder). Renditions, route responses, the reviewer transcript and the larger
logs are listed in `evidence.json`. Everything smaller is in `small-raw.tar`.

## Bindings

`bindings/bindings.txt` records:

- HEAD, the tree and the base;
- that `ba47c2d1` is an ancestor;
- the pre-rebase composed commit, `55156163`, whose owned files are identical
  to HEAD's;
- the preserved tags;
- the sha256 of every owned file at HEAD.

The `evidence-s3.ts` sha256 is `4dde2e5d…`, matching Oren's review binding.

## Checks on `706e879b`

All of these exited 0; full logs are in `checks/final/`:

- `clankie heavy -- pnpm fmt:check` and `pnpm lint` on the owned files;
- `pnpm --filter @clankie/clankie typecheck`;
- `pnpm exec vitest run` on the thumbnail and evidence-device integration
  tests: 8 of 8 passed.

After every command, the lockfile and `node_modules` showed no drift.

**Drift caught and corrected.** During the first S3 proof runs, a
`pnpm exec tsx` invocation most likely re-resolved `pnpm-lock.yaml` and
`node_modules`. That cause is inferred, not confirmed. The bumps were
transitive AWS SDK and Smithy packages: `@aws-sdk/core` 3.978.1 → 3.978.3 and
`@smithy/core` 3.35.1 → 3.35.2. `@aws-sdk/client-s3` itself stayed on its
locked 3.1138.0.

I restored the lockfile and ran a frozen install. Then I reran every check and
the S3 proof by calling node and the tsx loader directly. The drifted runs are
kept and labelled, not restamped:

- `checks/drifted-install/`: checks, all exit 0, plus the lock diff and the
  restore log;
- `s3-combined/drifted-run/`: the MinIO launch and teardown of the drifted
  session, plus the output of its third and last S3 iteration.

Three S3 iterations ran on the drifted install while the script was being
extended (07:17:52Z, 07:18:14Z and 07:18:34Z). Each overwrote the previous
iteration's `combined.json`. Only the third output was copied into the
evidence; the first two survive as verbatim session-transcript excerpts, kept
locally in the owned clone at
`.local/vuh1954-proof/composed/drift/earlier-drifted-iterations/` and not in
the evidence store. They differ in one timing-dependent case: in the second
iteration, the 3 ms open rejected; in the third drifted iteration and in the
frozen run, it resolved and the body errored instead.

The frozen-install run (07:23:22Z) is the proof bound below. The third drifted
iteration gave the same outcome for every case, with timings within 6 ms.

## Decisive device boundary on `706e879b`

`real-composed/` is a fresh canonical `scratch-stack --broker-operator` stack
on ports 57147–57149. Service and relay were descendants of one owned
`clankie heavy --server` runner, PID 82238:

- service 82287, listening as 82288;
- relay 82488, listening as 82490.

Run steps:

1. Auto off came first; the preflight showed no devices.
2. Seven PNGs were uploaded and `applied`.
3. A device was paired with the normal offer, redeem and complete calls,
   through the preset relay.
4. Requests went device token → relay → service.

Results:

- **Thumbnails:** all seven are complete JPEGs that end with the EOI marker.
  They are byte-identical to the accepted `318c0d17` run, and repeats were
  identical.
- **Originals:** every range was reassembled; size and sha256 match for all
  seven.
- **Authorization:** no bearer → 401, wrong bearer → 401, unknown sha256 →
  `unavailable`, after revoke → 401.
- **CPU enforcement:** the wrapper again logged
  `CPU enforcement degraded … Process identity unavailable`. That is not
  evidence of zero CPU or of hard enforcement.
- **Teardown** (`bindings/teardown.txt`):
  - all five PIDs are gone and all three ports are free;
  - the scratch root and its broker were removed, with no lease left;
  - exit codes: relay 1, service 143 after SIGTERM.

## Combined preview → real S3 cancellation

`s3-combined/` uses an owned loopback MinIO, started from Oren's retained
binary. Its sha256, `2f907af9…`, matches his verified provenance
(`bindings/oren-minio-provenance-verified.json`). It ran under
`clankie heavy --server` with random fixture credentials, which never appear in
logs.

The setup used the real AWS SDK (`@aws-sdk/client-s3` 3.1138.0) and
`S3EvidenceBlobs`, with SQLite metadata from `EvidenceStore.withLocalMetadata`.
A wrapper delegates every call to `S3EvidenceBlobs`. Its `open` records the
signal and how the promise settled. It also wraps the real S3 body reader in an
observer stream, which forwards each chunk, error and cancel unchanged and
records how the body ended.

The script has three parts, and only A goes through `devicePreview`:

- **A. `devicePreview` served from S3** (default 5 s deadline): a JPEG of
  29,924 B, 353×768, byte-identical to the local-disk rendition. The miss made
  one S3 open carrying the deadline signal; the cache hit made zero S3 opens.
- **B. Deadline during the open or the body read:** `EvidenceThumbnails`
  called directly, not `devicePreview` or HTTP. Each case used a new instance
  with a shortened injected deadline (1, 3, 10, 30, 100 ms) and the same
  `open(sha256, abortSignal)` callback shape on the real S3 wrapper:
  - 1 ms: the in-flight open rejected with the render's
    `Evidence thumbnail timeout`;
  - 3 ms (a screenshot): the open resolved at 3 ms, then the S3 body errored
    with that timeout at 4 ms;
  - 10 and 30 ms: the body was read to the end, and the render timed out on
    its own checks;
  - 100 ms: it rendered a JPEG.
- **C. Deadline while a 15 MiB body is still streaming:** the same direct
  `EvidenceThumbnails` call with 6, 10 and 20 ms deadlines. The body is the
  8-byte PNG signature followed by random bytes. It is not a valid image, so it
  shows only that the abort reaches a streaming S3 body:
  - 6 and 10 ms: the open resolved, then the S3 body errored with the timeout
    at 8 and 11 ms;
  - 20 ms: the body was read to the end and refused as `not_previewable`.

Not shown here: the default-deadline timeout through `devicePreview` or the
device route against S3.

**Teardown and retention.**

- MinIO (`minio-teardown.txt`): both PIDs gone, ports free, scratch data and
  the credential file removed, no lease left.
- The script also created one SQLite metadata root per run with
  `mkdtemp(tmpdir(), 'vuh1954-s3-')`. These sat outside the owned MinIO and
  scratch-stack roots and were not covered by those teardowns. There were four,
  one per iteration. Each was positively mine: the prefix, a creation time
  within 3 s of one of my runs, and records with the proof actor and my
  fixtures.
- Each held only `evidence.sqlite`, with nonsecret upload and record metadata:
  sha256s, sizes, file names and the proof actor. There were no credentials or
  S3 location.
- I copied each file, sha-verified, into the owned clone's ignored
  `.local/vuh1954-proof/s3/tmp-metadata-roots/`. Then I removed each original
  by its exact path; no glob delete. `retention.txt` there lists the paths and
  hashes. These copies are local only, not in the evidence store.

Oren's own seam proof covers the SDK cancellation cases directly
(`bindings/oren-abort-proof.json`): 10 checks, nothing mocked. It is reused
here as his, not restamped.

## Final HIGH review

`reviews/independent-review-4-composed.md` and the full transcript record the
same independent native subagent. It reviewed `706e879b` against the landed
seam:

- there are no HIGH or MEDIUM issues;
- lead findings 1 and 2 stay fixed;
- an abort during the open or during the body is classified as a timeout and
  not cached;
- no listener or stream leaks on the success or refusal paths.

Its earlier passes are in `../2026-10-14-vuh-1954-thumbnails-refined/`.

## Gaps

- **Possible misclassification (LOW, not changed, to keep the bindings):** if
  a store errors its body on its own just after the abort, the error would be
  classified as `unreadable` rather than `timeout`. That doesn't happen with S3
  or local disk.
- **Small previews:** the path for previews under 64 KiB still calls
  `blobs.open` without a signal.
- **Local disk:** it ignores the signal. Reads there are cancelled by the
  render itself.
- **Other gaps:**
  - `findRecordForBlob` is still optional on the interface;
  - level-6 PNG deflate means a borderline transparent image may step down an
    edge;
  - the 65,536-chunk cap could refuse unusual valid files;
  - the costliest-raster tests are load-sensitive.
- **Not covered here:**
  - the app's sticky `unavailable`, which is filed separately;
  - the unchanged bearer preview route;
  - live UI, a real phone, hosted S3, and deploy.
