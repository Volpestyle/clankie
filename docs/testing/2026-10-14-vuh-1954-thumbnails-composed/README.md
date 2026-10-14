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
`node_modules`. It bumped AWS SDK minor versions, for example the credential
provider's `@aws-sdk/core` 3.978.1 → 3.978.3. That cause is inferred, not
confirmed. The client-s3 package itself stayed on the locked 3.978.1.

I restored the lockfile and ran a frozen install. Then I reran every check and
the S3 proof by calling node and tsx directly. The drifted runs are kept and
labelled:

- `checks/drifted-install/`: checks, all exit 0, plus the lock diff and the
  restore log;
- `s3-combined/drifted-run/`.

Results matched on both installs.

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

The setup used the real AWS SDK and `S3EvidenceBlobs` with SQLite metadata. A
delegating wrapper only records each `open`'s signal, how it settled, and how
its body ended.

- **Served from S3 through `devicePreview`:**
  - a JPEG of 29,924 B, 353×768, byte-identical to the local-disk rendition;
  - one S3 open on the miss, carrying the deadline signal;
  - zero S3 opens on the cache hit.
- **Deadline during the SDK request (1 ms, 3 ms):** the in-flight open rejected
  with the render's `Evidence thumbnail timeout`.
- **Deadline while a 15 MiB body was still streaming (6 ms, 10 ms, and 3 ms on
  a screenshot):** the S3 body stream errored with that same timeout reason.
- **Later deadlines:** the bodies were read to the end, and the render timed
  out or answered on its own terms.
- **MinIO teardown** (`minio-teardown.txt`): both PIDs gone, ports free,
  scratch data and the credential file removed, no lease left.

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
