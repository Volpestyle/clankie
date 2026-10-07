# ADR 0239: Landing gates what changed

Status: Accepted (James, 2026-10-06). Narrows the gate in
[integration](../integration.md); the full `pnpm check` is unchanged.

## Context

The landing queue ran the whole `pnpm check` in each repository for every
batch. On 2026-10-06 one app-only batch spent over an hour in core's full
suite, failing 13 test files (the three rerun in an ordinary checkout passed), one
of them spending 15 minutes on 30-second timeouts. Seven batches waited behind it, and
a failed shared gate splits into more full runs. No batch on this Mac's record had
passed since the queue started, while hundreds of commits reached `main`
around it. The owner's
standing rule is that per-landing checks stay fast and narrow, with full suites
for releases and explicit manual runs.

## Decision

The gate runs a repository's `check:landing` script when it defines one, and
`check` otherwise. The queue passes the batch's base commit as
`CLANKIE_LANDING_BASE`.

Both repositories define `check:landing` as formatting (core), lint, typecheck,
cheap repository checks, and only the tests Vitest relates to files changed
since that base, stopping at the first failure. The full `pnpm check` (every
test, dead code, public docs, infra, vox) runs for releases and on request.

## Consequences

- A landing costs an install, typecheck and the affected tests instead of the
  whole suite, so the queue can keep up with the fleet.
- A test broken by a change outside its import graph is not caught at landing;
  the release check catches it. Tests that only fail in the gate's isolated
  environment still need fixing; they now block only changes that touch them.
- A repository opts out by not defining `check:landing`.
