# VUH-2005: host-measured heavy sizing and admission

Tracks: https://linear.app/vuhlp/issue/VUH-2005

Source `55bc76a27`, based on fetched `origin/main` `4ffbc7eb3`.
Mac-local prerequisite for VUH-2091, not a shipped Windows governor.

The exported heavy policy accepts validated host CPU/RAM facts, using them for
ceiling, base slots and unsettled core charges. Omitted facts retain local OS
observations. Automatic capacity now respects the machine API's 64-slot maximum.
Invalid facts throw even with an owner override; no observer-hardware fallback.
No client flag, alternate registry, POSIX process boundary or disk-floor change.
Moss (VUH-2132) confirmed independent submission; he will rebase his disk slice.

Verification through `clankie heavy`:

- Frozen install passed. Initial test/typecheck attempts could not start because
  this fresh worktree lacked Vitest/TypeScript; retained separately.
- Seven focused files / 34 tests passed, exit 0. Host policy/protocol contracts,
  real-process heavy admission, bounded load progress and cleanup, light lane,
  machine API/settings isolation, service runtime and CLI consumers.
- Package typecheck passed, exit 0. Touched TypeScript lint passed, exit 0.
- Real local observation: 18 cores / 128 GiB → ceiling 9, base 4. Explicit measured
  facts return the same ceiling. This is local Mac proof, not remote PC proof.
- Formatter ran on all touched files; final explicit-file format check retained.

Reproduce focused checks:

```sh
clankie heavy -- pnpm exec vitest run packages/fleet-resources/test/host-specs.integration.test.ts packages/fleet-resources/test/heavy-admission.integration.test.ts packages/fleet-resources/test/full-progress.integration.test.ts packages/fleet-resources/test/light-lane.integration.test.ts apps/clankie/test/machine-fleet-resources.integration.test.ts apps/clankie/test/service-fleet-resources.integration.test.ts apps/tui/test/fleet-resources-cli.integration.test.ts
clankie heavy -- pnpm --filter @clankie/fleet-resources typecheck
```

Open: native Windows runtime, canonical native/WSL single-budget wiring, interop
containment, setup and real PC process/crash/cleanup proofs (VUH-2091). KH2 keeps
`ctest.lock` until its lead proves migration/exclusion (VUH-2093). No PC calls,
WSL C/C++ builds, remote gates, simulator boots or evals were performed.
