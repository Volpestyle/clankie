# VUH-1913 Phase A current-base runtime proof

Tracks: VUH-1913 — Clankie Work.

At runtime capture (2026-10-14 12:36Z, historical stage): exact frozen base `8c4dbd85722fa3ad86570de7ceb711b74fec7c70`, eight dirty source bindings and diff `7a17919366be74a68a963e9d42d1b4d5938ad38224f2c8d804d3f13d460f4c14`. Four existing tests across two files passed (no skips), with zero child/test/server wrapper exits. Three Phase A cases use production authentication, private FileCredentialStore, HTTP, SQLite/files, production SDK and owned loopback MinIO; the foundation case retains its controlled callback. One server lifetime ended with positive PID/port/credential/fixture cleanup. Distinct HIGH supporting review inspected actual outputs and limits.

`runtime-proof.json` is the sanitized raw archive; stable store references are in `evidence.json`. Local raw originals and private fixture metadata remain ignored; credential values and private bindings are excluded. Product inputs/dependencies remained unchanged; at runtime capture there was no commit, submission, ISSUE check or closure. The proved source was later committed unchanged as the VUH-1913 Phase A candidate; its gate and landing are recorded on the issue, not here.

Limits: full service startup, hosted/renewable tenant credential delivery and owner activation remain unproved. Signed-GET mismatch cancellation and genuine post-install database failure remain source-reviewed only. Preparation bounds association progress, not transport lifetime. Old 3b6 proof stays separate; excluded preview routes remain active-backend-only. Owner3465 and PhaseB/cloud holds remain.
