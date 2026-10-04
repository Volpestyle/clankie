# ADR 0221: Tests prove the product and its boundaries

Status: accepted (James, 2026-10-04).

## Context

[VUH-1635](https://linear.app/vuhlp/issue/VUH-1635) reproduced a host/app boundary
failure: the old app schema (`c4b9bd53`) rejects host-valid optional
`harnessBridge` (`75128da8`) and `subagents.recent.{id,startedAt,endedAt}`
(`3b6c7c3c`) with `unrecognized_keys`, leaving the fleet empty. Juno's
old-client/new-host schema reproduction catches what unit tests did not.
Tolerant client response parsing and its integration regression are in flight;
the phone's exact bundled revision and a route-only defect are not established.
Agents make consequential mistakes where data and API boundaries meet and
schemas drift. Testing isolated implementation details gives little protection
against those failures.

## Decision

New work adds coverage in this order:

1. **Full E2E:** exercise the product with real dependencies, nothing mocked.
   Production test accounts through Playwright or an equivalent are a valid path
   when authorized.
2. **Integration:** exercise real producers and consumers across data, API and
   schema boundaries, including old-client/new-host compatibility when relevant.
3. **Golden:** ground behavior in real data examples and retain them as edge-case
   regressions.

Do not add unit tests by default. With frontier coding agents, they are bloat
99% of the time. Reviewers ask for evidence at the changed boundary and push
back on new unit-test bloat, rather than rewarding test count.

## Scope

This changes what new work adds. Existing unit tests are not mass-deleted;
pruning is a separate reviewed effort. Scale checks to the change and reuse
valid evidence. This creates no new CI or per-commit full-suite requirement.
Evals remain manual-only.
