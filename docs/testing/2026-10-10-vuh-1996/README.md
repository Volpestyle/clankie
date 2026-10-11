# Scratch stack isolation (VUH-1996)

Tracks: https://linear.app/vuhlp/issue/VUH-1996

Baseline: fetched `origin/main` at `98de6abb98f9f18a112fc0bd2a09fc341af0599c`
still defaulted the relay listener to `4321`, both upstreams to `4310`, and
the service's advertised relay to `4321`. The issue had no comments.

The paired scratch preset chooses distinct free loopback ports, private state,
settings and file credentials. Its launcher drops inherited configuration.
Both production entrypoints refuse installed ports for scratch listeners and
peers before initializing credentials or upstream clients. The service checks
again after saved relay settings are projected. Scratch mode is explicitly
`CLANKIE_SCRATCH=1`; custom production state directories and `NODE_ENV` alone
retain the installed ports. Relay port `0` is refused on the service because
pairing otherwise falls back to `4321`.

The focused integration test runs the real entrypoints with unsafe defaults
and explicit unsafe overrides, then boots a real service and relay, completes
device pairing, checks the advertised scratch relay, and reads host settings
through that relay using the scratch device token. Its parent environment
deliberately contains live-port overrides to prove the launcher removes them.
Host scratch fixtures never bind or target `4310`/`4321`; the production
regression uses those ports only inside a network-isolated Docker container.
Only owned temporary processes and that exact container are stopped. No simulators or evals are used.

Verification:

- `clankie heavy -- pnpm exec vitest run apps/relay/test/scratch-stack.integration.test.ts apps/clankie/test/issue-metrics-journey.test.ts`: exit `0`, two files / twelve tests passed, `58.51s`. The real paired-stack case completed pairing and received `200` for host settings through its advertised scratch relay.
- `clankie heavy -- pnpm --filter @clankie/relay typecheck`: exit `0`.
- The first paired-proof assertion incorrectly inspected redemption before activation; corrected to complete pairing. A later refusal run hit one aggregate `60s` deadline across ten launches under fleet load; the final cases are separate tests retaining the same `20s` child deadline. Assertions and product defaults were not relaxed.

The [initial candidate capture](clankie://evidence/sha256/fbb2bfae9e68fbd7b76d5bff9a4b154f6b384b11642d9fb6d6234163bfdd7fc4)
retains that output and candidate source. Lead review found its state-path
inference would refuse hosted `/state/runtime` on port `4310`. The current
guard requires the explicit scratch flag; neither state paths nor `NODE_ENV`
infer it. The corrected focused rerun passed thirteen tests across four files;
its first Docker attempt failed because the seed image used different presence
module paths. A second attempt exposed PID 1 violating the existing health
response contract. The fixture now supplies the seed image paths and `--init`,
matching a service launched as a child. The final Docker-only rerun passed
(exit `0`, one test, `7.16s`). Neither failure changed product assertions.
The requested `service-fleet-resources.integration.test.ts` is absent in this
checkout and was not counted as a pass; the lead is checking its ownership.
The [review-correction capture](clankie://evidence/sha256/aaf79a8c13f99df987c32079647c719ac252365e16bc5b05248e7d83181ce720)
retains the rerun results, fixture failures and corrected source. Final landing
verification remains pending.

The manual Docker regression bundles the current service and relay with the
release's JavaScript bundle options, mounts those bundles into an existing
hosted runtime image, and boots both entrypoints on canonical container-only
ports. Docker uses `--network none`, no published host ports, private container
state, no scratch flag, and `NODE_ENV=development`. The production defaults
must remain healthy. Run it with `VUH_1996_DOCKER_PROOF=1` and optionally
`VUH_1996_DOCKER_IMAGE` under `clankie heavy`; ordinary gates skip this Docker
test. It is a runtime regression proof, not a full image/release build.

## Conflict reconciliation, 2026-10-11

Original request `1cee7398-ac4e-409d-8ca3-6eaf93bc19f8` terminated in a skill
conflict and was excluded from landing. The reconciled branch is based on fetched
`origin/main` at `8c93bbc09e60740d57eddc47bb2254fa3f45d17c`. It preserves the newer
server-lane guidance and the metrics harness's test mode/private fleet registry.
Scratch launch examples now use `clankie heavy --server`.

Focused affected checks on this rebased input passed: scratch-stack integration
and issue-metrics journey, two files / 12 tests, exit 0, 69.83 seconds. The manual
Docker production regression passed again: one test, exit 0, 9.59 seconds, with
network disabled and no published host ports. No duplicate local root gate runs;
the new integration request supplies the authoritative exact-tree gate.
Formatter on the conflict-resolved skill/test and updated CLI examples passed.
[Reconciliation evidence](clankie://evidence/sha256/34728dfa600e397aa6014610b44f91d83bf4a2551cdaad50ce9b8ef6b986af2f)
contains the terminal conflict receipt, rebased diff and passing check output.
