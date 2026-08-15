# docs

The repo's documentation: one architecture
overview plus the `adr/` decision records for
Clankie's surviving subsystems — play mechanics,
voice, Discord presence, media, browser/shell,
memory. Read `architecture.md` first; it maps the
tree and names the 2026-08 pi rewrite that shaped
it.

## Children

- `architecture.md` — top-level system map: one
  service (`apps/clankie`) plus surfaces, the
  message→turn flow, and the pi-rewrite story.
- `adr/` — 49 numbered architecture decision
  records (0012–0090, with deliberate gaps).

## Notes

ADR numbering has gaps: the governance-era ADRs
(missions, doctrine, worker protocol) were deleted
in the pi rewrite and live only in git history.
Many surviving ADRs still mention pre-rewrite
structures (Eve sessions, control plane, runner,
missions); their invariants carry forward into the
single `apps/clankie` service.
