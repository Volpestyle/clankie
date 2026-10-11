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
No fixture service or relay binds or targets `4310`/`4321`; only owned temporary
processes are stopped. No simulators or evals are used.

Verification:

- `clankie heavy -- pnpm exec vitest run apps/relay/test/scratch-stack.integration.test.ts apps/clankie/test/issue-metrics-journey.test.ts`: exit `0`, two files / twelve tests passed, `58.51s`. The real paired-stack case completed pairing and received `200` for host settings through its advertised scratch relay.
- `clankie heavy -- pnpm --filter @clankie/relay typecheck`: exit `0`.
- The first paired-proof assertion incorrectly inspected redemption before activation; corrected to complete pairing. A later refusal run hit one aggregate `60s` deadline across ten launches under fleet load; the final cases are separate tests retaining the same `20s` child deadline. Assertions and product defaults were not relaxed.

The [initial candidate capture](clankie://evidence/sha256/fbb2bfae9e68fbd7b76d5bff9a4b154f6b384b11642d9fb6d6234163bfdd7fc4)
retains that output and candidate source. Lead review found its state-path
inference would refuse hosted `/state/runtime` on port `4310`. The current
guard requires the explicit scratch flag; neither state paths nor `NODE_ENV`
infer it. Final focused checks and landing are pending.

The manual Docker regression bundles the current service and relay with the
release's JavaScript bundle options, mounts those bundles into an existing
hosted runtime image, and boots both entrypoints on canonical container-only
ports. Docker uses `--network none`, no published host ports, private container
state, no scratch flag, and `NODE_ENV=development`. The production defaults
must remain healthy. Run it with `VUH_1996_DOCKER_PROOF=1` and optionally
`VUH_1996_DOCKER_IMAGE` under `clankie heavy`; ordinary gates skip this Docker
test. It is a runtime regression proof, not a full image/release build.
