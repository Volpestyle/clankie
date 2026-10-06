# Pane-address repair checks

VUH-1527, 2026-10-06. Branch `tess/vuh-1527-remote-channels`, based on deployed
`2e1c08be` plus evidence checkpoint `30045480`.

The live hire passed `pc/wC:p2` to the process observer's bare-only guard and
failed before brief delivery. The observer now accepts either address form only
within its exact registered fleet, sends the bare pane to kernel probes and
private-seat checks, and preserves the requested address on the resulting proof.
Native membership reads normalize to the original qualified allocation while
retaining occupant, process lifetime, socket/shell binding and revision checks.
An older bare allocation remains unconfirmed/invalid rather than falling through
to workspace admission. No receipt or allocation is migrated, erased or adopted.

Passed:

- **190 focused tests in five files**, through the fleet heavy limiter:
  `remote-project-proof.test.ts`, `project-hire-pane.integration.test.ts`,
  `project-hires.test.ts`, `fresh-hire-intent.integration.test.ts`, and
  `fleet-project-membership.test.ts` under `apps/clankie/test/`.
  Observer coverage includes bare/qualified addresses, bare kernel arguments,
  registered private seats and cross-fleet/malformed refusals. The new journal
  integration uses captured PC pane/process identities with explicit fixture
  session/binding values; it is not live Windows process evidence. It covers
  both lookup/proof forms after reload, unchanged journal bytes, stale identity,
  binding and revision refusals, plus retained legacy/unproved allocations.
- `pnpm --filter @clankie/clankie typecheck`, through the heavy limiter.
  The first run exposed stale workspace dependency links after the main update.
  A real `pnpm install --frozen-lockfile`, also limited, refreshed this worktree's
  installation; the subsequent typecheck passed. No lockfile changed.
- Scoped `oxlint --deny-warnings`, formatting and `git diff --check` for the delta.
- [Independent native security review](SECURITY-REVIEW.md): approved.

No full `pnpm check`, simulator, PC launch or account/config change ran for this
repair. Existing live evidence remains the [failed owned-pane acceptance](../README.md#deployed-2e1c08be-pc-acceptance-process-proof-refusal).
After deployment, use a **new** intent and owned Codex panes for hire → brief →
follow-up → completion → peer message plus tracker isolation checks. The prior
fresh intent and receipt remain abandoned and permanently fenced; never resend
them. If reconnecting reproduces after this repair, attach that observation to
VUH-1738. VUH-1527 remains In Progress pending live evidence.
