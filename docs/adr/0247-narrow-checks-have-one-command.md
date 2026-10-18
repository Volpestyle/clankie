# ADR 0247: The root landing gate has one command

Status: Accepted (James, 2026-10-07; root pre-push requirement approved 2026-10-09).
Defines [ADR 0240](0240-changes-land-directly-on-main.md)'s required root landing
command, and makes the optional `clankie integrate` gate run it.

## Context

ADR 0240 lands changes directly on `main` after narrow checks: formatting,
typecheck and the tests that cover the change. Each agent assembled those by
hand. The optional `clankie integrate` queue still ran the whole `pnpm check`
per batch; on 2026-10-06 one app-only batch spent over an hour in core's full
suite, failing 13 test files (the three rerun in an ordinary checkout passed),
one of them spending 15 minutes on 30-second timeouts.

## Decision

Both repositories define `pnpm check:landing`: formatting (core), lint,
typecheck, cheap repository checks, and only the tests Vitest relates to files
changed since a base, stopping at the first failure. The base is
`CLANKIE_LANDING_BASE`, defaulting to HEAD's merge-base with `origin/main` (VUH-2024). The app runs each
package's own tests from inside that package, as its full suite does.

The root command is required before every direct push. Hand-picked checks are
for iteration and do not replace it. Rebase onto fetched `origin/main` first;
the gate fixes that base SHA for its run. Source changes require another root
gate before pushing; a base change alone requires one unless
`pnpm check:landing --revalidate` passes ([ADR 0240](0240-changes-land-directly-on-main.md), VUH-2024). Report its checked HEAD, base, exit and evidence path.
A clean-main comparison after pushing may select zero tests and cannot prove
the landing was checked.

If the root gate's only failures are unchanged timing-sensitive cases outside
the change and its affected imports, the lead may accept the landing after
every exact failing case passes in isolation on unchanged test/product inputs.
Retain the gate's real nonzero exit, exact errors, load samples and isolated
results, labelled **Full-gate result** and **Isolated passes**. This is a lead
acceptance decision, not a green full gate. Failures in changed code or affected
consumers still block; do not weaken assertions, timeouts or product defaults.

Core typechecks the compiler projects reached by actual imports, including
type-only and relative imports across packages, and runs compilers serially.
Compiler/dependency configuration changes retain all compiler checks. The Vitest
`--changed` selector remains unchanged. Each phase's wall time and compiler scope
are retained in `.local/landing-gate.json`.
The actual compiler inputs also contribute to Turbo's cache key through
`CLANKIE_LANDING_TYPE_INPUTS`; relative imports cannot reuse a result that predates
an imported source change merely because the package manifest omits that dependency.

Amendment, 2026-10-18 ([VUH-2460](https://linear.app/vuhlp/issue/VUH-2460)):
landing omits the explicitly listed timing-sensitive native/process proofs in
[`landing-test-policy.mjs`](../../scripts/testing/landing-test-policy.mjs).
The root gate selects this policy with `CLANKIE_LANDING_TESTS=1`; the shared
Vitest configuration applies it to both parallel and serial projects. Plain
`pnpm test` and release checks retain these files, with their original assertions
and deadlines. The eval and opt-in computer exclusions are unchanged. Cheap
runtime-canary policy checks and the roster shutdown/lifecycle regression remain
in landing. ADR 0221 still governs how tests are written; this changes when
these proofs run. There is no blanket cap on transitive integration selection.

Core includes `pnpm deadcode` (knip) in this landing command. Full-gate
measurements on 2026-10-07 put it at 1.8–3.1 seconds. That small cost catches
unused exports and missing dependency/entry declarations before they reach the
release gate; it does not select more tests or include evals.

`clankie integrate` runs a repository's `check:landing` when it defines one,
passing the batch base, and `check` otherwise. The full `pnpm check` stays for
releases and explicit runs.

## Consequences

- One root command is required by ADR 0240 before a direct push, and the
  optional queue finishes in minutes instead of running the whole suite.
- A change that breaks a test outside its import graph is not caught until a
  release or full run, as ADR 0240 already accepts. Tests that only fail in the
  queue's isolated environment still need fixing.
- A repository opts out of the queue's narrow gate by not defining
  `check:landing`.
