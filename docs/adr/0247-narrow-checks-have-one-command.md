# ADR 0247: Narrow checks have one command

Status: Accepted (James, 2026-10-07). Gives
[ADR 0240](0240-changes-land-directly-on-main.md)'s narrow-check step one
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
`CLANKIE_LANDING_BASE`, defaulting to `origin/main`. The app runs each
package's own tests from inside that package, as its full suite does.

`clankie integrate` runs a repository's `check:landing` when it defines one,
passing the batch base, and `check` otherwise. The full `pnpm check` stays for
releases and explicit runs.

## Consequences

- One command covers ADR 0240's narrow checks before a direct push, and the
  optional queue finishes in minutes instead of running the whole suite.
- A change that breaks a test outside its import graph is not caught until a
  release or full run, as ADR 0240 already accepts. Tests that only fail in the
  queue's isolated environment still need fixing.
- A repository opts out of the queue's narrow gate by not defining
  `check:landing`.
