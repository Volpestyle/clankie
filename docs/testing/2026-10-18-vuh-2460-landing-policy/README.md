# VUH-2460 — landing skips release-only timing proofs

Tracks: https://linear.app/vuhlp/issue/VUH-2460

The six issue-named timing-sensitive files are listed once in
scripts/testing/landing-test-policy.mjs. The landing command selects that policy
in the shared Vitest configuration, so it applies to parallel and serial tests.
Plain pnpm test and release checks continue to include every moved file. No
existing test body, deadline, product default or eval boundary changes.

Real Vitest file discovery proves all six remain in manual selection, leave
landing, and preserve the cheap runtime-canary policy, fleet-refresh lifecycle
and remote queue controls. The manual eval corpus and opt-in computer tests
remain excluded in both modes. The CLI-only attempt failed this check because
project configuration overrode it; the corrected shared policy passes. All 13
policy/revalidation integration cases pass. Discovery never executes an eval.
Raw red/green evidence is retained in discovery-proof.json through evidence.json.

The required exact-tree landing gate is pending at this checkpoint. The same
change comparison and measured history decision follow the first six-file move.
Existing VUH-2462 gate evidence supplies the unchanged feature workload baseline;
compiler-cache differences must be distinguished from test-selection savings.

The central history has 530 gate outcomes beginning October 10, less than two
weeks. A bounded metadata scan found 149 retained gate reports. Missing per-file
failure attribution is unknown, not a flake or an absence of real catches. The
stale clankie-ops app failures were setup drift and require no test removal.
