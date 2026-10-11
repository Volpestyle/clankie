# VUH-2130 — pane hire provenance through re-adoption

Tracks: https://linear.app/vuhlp/issue/VUH-2130

`HireOwners.readopt` discarded the persisted `hired` flag while rebinding the
same native thread. Tidy then failed known hires with `provenance_unknown`.
Preserving true, false and missing values repairs known hires without turning
adopted or legacy-unknown panes into hires.

## Proof

The archived `proof.json` contains the named logs below and exact checked source
files with SHA-256 hashes.

- `before-fix.log`: removing only the flag-preservation fix makes both local and
  remote same-thread deploy/re-adoption regressions fail with unknown provenance.
- `focused.log`: 104 tests pass across five focused files covering pane tidy, hire recovery, watch ownership,
  remote lead HTTP consumers and worker-refresh ownership.
- `lint.log` and `format.log`: explicit touched-file checks.

The fixture uses a real Unix socket with the production Herdr JSONL client,
Herdr runner parsing and remote fleet qualification. Ownership and report journals
are real files reloaded before re-adoption and again afterwards. ANSI comes from
captured native composer fixtures; unlanded-work checks use a real linked Git
worktree. It proves successful close/removal of a known hire, refusal of adopted
hand-started panes, missing legacy provenance, unsent drafts and unlanded work.
Remote worktree observation remains unknown and holds close until an explicit
handoff reason is recorded. This is a socket boundary fixture, not a live Codex
TUI, SSH or Windows run; no live owner panes were created or closed.

## Historical cases and limits

- `w4K:p1`, seat `term_65d92fa49aae414f`: the current persisted owner record
  has no `hired` flag after same-thread re-adoption following the 18:17Z deploy.
  The code path and failing fixture reproduce that loss. Already-erased records
  are not automatically upgraded to hires.
- KH2 lead `pc/w9:pT`: the existing issue captures the `owner_interactive`
  refusal. Its owner journal has `hired:false`; no matching project-hire record
  or original hire receipt was found in the retained conversation events or
  remote lead launch records. The lead confirmed it may have been adopted rather
  than hired and that the pane is already gone. Adoption alone remains insufficient.

Integration supplies the root landing gate and push receipt; the lead closes the
issue after landing and reviewing this evidence. No release or live service
restart is part of this change.
