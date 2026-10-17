# Remote lead tracker project fence

Tracks: [VUH-1968](https://linear.app/vuhlp/issue/VUH-1968).

The issue remains open for a real KH2 owner-origin Linear wake. Its history
already records live remote-head tracker reads and writes on 2026-10-09/10.
This amendment fixes the separate project authority gap found on `cc2eb50e5`:
remote tracker tools inherited the connected account's access to other projects.

The service selects the tracker UUID from the owner's registered project route
or remote workspace. Direct and deferred calls use the same project guard.
Membership and settings are rechecked at dispatch, with the original seat/chat
attribution and connected Clankie identity. Missing or conflicting bindings
refuse. Unscopable tracker operations stay unavailable; supported operations and
limits are documented in ADR 0259's tracker delegation section.

## Local proof

`clankie heavy -- pnpm exec vitest run apps/clankie/test/remote-project-leads.integration.test.ts apps/clankie/test/remote-lead-fleet-wakes.integration.test.ts`
passed: 2 files, 4 tests, no skips.

The existing remote launch acceptance now uses real temporary tracker records
behind the provider transport fixture. It exercises the real settings,
conversation store, captain bank, launch delegation and HTTP/MCP client:

- Own-project issue read, comment creation and deferred issue update succeed.
- Listing without a caller project exposes only own-project records.
- Foreign issue reads/writes and project reads/list filters refuse, through
  direct and deferred calls; refusal output contains no foreign issue title.
- Project moves/removal, cross-project relations and foreign comment edit/reply
  IDs paired with an own-project target refuse. Foreign records stay unchanged.
- Removing project registration blocks reads and writes from the existing MCP
  client before provider dispatch; restoring it restores access.
- Original chat attribution, repository/service exclusions, native workspace
  revocation and a queued write's delegation-revocation refusal remain covered.
- The existing wake fixtures pass. They establish local routing behavior, not a
  real KH2 owner event or live remote continuity.

Explicit touched-source lint passed. The source landed on main at `e13c5770c3a691320318255ab74322be6acdc00e`.
Its root `clankie heavy -- pnpm check:landing` passed against
`3a233db920e3f7f4a80497a19c123ff6d8b5f754`: exit 0, `sourceStable: true`,
84 selected files, 581 tests passed / 1 skipped, all three affected package
typechecks passed. Elapsed gate time: 459.22 seconds. Final pull was unchanged;
push to main succeeded. No timing exception was used.

The first root gate stopped before tests: the new fixture's project literal
lacked the required `worktreeRoots` field (`TS2741`). It was corrected with an
empty worktree-root list and the full root gate rerun. The nonzero first gate and
passing source gate reports/logs are retained in this folder's evidence manifest.

## Boundaries

No PC interaction, live runtime change, restart or deployment was performed. Native
Windows process/transport observation and the upstream provider transport are
fixture seams; the tracker records and service-side authorization are real.
The connected account is fixture-only. Existing live app-identity proof remains
in the issue history; this run does not reauthenticate or exercise production
Linear from a remote head. Provider-side concurrent issue moves cannot be atomic
with the service pre-dispatch membership check; issue reads also validate their
returned record before exposing it.

The initial focused attempt failed on the fixture's unset team; it was set to
`VUH`. An initial source typecheck found a narrowing error, and initial lint found
a constant-loop condition; both were corrected before the retained passing run.
