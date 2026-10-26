# VUH-1913 Phase A on current main

Tracks: VUH-1913 — Clankie Work.

Phase A was already on main as `c80aea6b5734eda200b3ef89d2831cfbb82fc35c`
(2026-10-14). All five product and test files in Oren's frozen candidate
(diff `7a179193`, [runtime proof](../vuh-1913-phase-a-runtime-20261014/README.md))
match that commit byte for byte. Since then only `apps/clankie/src/evidence-store.ts`
has changed on main.

Re-proof on `0f6226cbde2b5e8805a04da22287ca0b8d382449` (2026-10-25): both
MinIO-gated integration files ran against an owned loopback MinIO
(`minio@RELEASE.2025-09-07T16-13-09Z`, binary `2f907af9`) started under
`clankie heavy --server` with fresh disposable root credentials. Result: 2 files,
4 tests passed, 0 skipped, exit 0. The S3 case pushes and fetches through
`runEvidenceCommand` and the real HTTP evidence routes. The storage case uses the
real FileCredentialStore and the production operator authenticator.
After the run, MinIO exited 0 and its port was closed.

`reproof.zip` holds `proof.json` (source bindings and the run), the raw
Vitest and MinIO logs, MinIO provenance and the landed `c80aea6b5` patch. None
contains credentials.

Limits: disposable loopback MinIO, not the hosted bucket. This is not a
full-service startup or installed-service proof. The service was not restarted
or deployed.
