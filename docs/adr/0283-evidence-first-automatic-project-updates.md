# ADR 0283: Evidence-first automatic project updates

Status: accepted for [VUH-2566](https://linear.app/vuhlp/issue/VUH-2566), James’s direct request, 2026-10-20.
Amends [ADR 0270](0270-auto-rounds-measure-outcomes-and-name-drift.md).

## Context

James requested default-on, per-project progress updates after KH2 accumulated
captioned takes and completed work without reaching another service milestone.
Milestone-only reporting hid meaningful progress already evidenced on its issues.

## Decision

- `autoUpdates` defaults on without rewriting saved projects. It uses the shared
  revision-fenced project create/update API, CLI and TUI. False retains the
  existing owner-loop behavior; silent suppresses all automatic status requests,
  and explicit landing cadence remains available. Strict clients opt into the
  additive project and round fields with `includeAutoUpdates=true`.
- Extend the existing velocity measurement and reporting claim, not a second
  scheduler or posting path. Reuse tracker reads and cached origin commits.
  A bounded hint sample reads at most three captioned media links from each
  issue description and each of its three most recently updated comments.
  Linear issue pages shrink to ten when requesting these nested hints; every
  issue page is still read, but comment threads are never scanned in full.
  Hints can miss older evidence and do not validate its contents.
- Two distinct started/completed issues with new media, or a completed issue
  linked to landed product commits, qualify for a lead review and one update.
  These are cheap evidence signals, not a judgment about the result's quality.
  The lead reads the previous update and changed issues, selects noteworthy
  results and leads with clips/stills at stable asset URLs and short captions,
  followed by open work and next steps. Nothing publishes automatically.
- Progress uses the latest observed status update or claimed request as its
  cutoff and waits at least 24 hours after it. Unknown status reads cannot
  authorize a progress request. Newly reached milestones are major events and
  keep their immediate path; explicit landing cadence also keeps its behavior.
- Existing journal claims, definite-refusal retries, uncertain-delivery handling
  and tracker-update attribution cover progress requests too. Event identities
  join the existing fingerprint and remain stable after a request is claimed.
  Turning progress updates off never cancels an earlier request.

## Consequences

This replaces ADR 0270’s default milestone-only posting restriction. Velocity
windows and drift measurement remain milestone-based. Full evidence review is
paid for only when reporting is due, rather than on every Auto tick. The app's
explicit project Settings UI needs its own control; API support alone does not
make that control appear in released clients.
