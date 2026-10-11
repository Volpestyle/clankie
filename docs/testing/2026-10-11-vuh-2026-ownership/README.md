# VUH-2026: live issue ownership

Tracks: https://linear.app/vuhlp/issue/VUH-2026

Started from fetched `origin/main` at `f87cdbe4fae158a8e354712d9eb5783b17ef0b6d`
in `/Users/james/dev/clankie-wt/vuh-2026`; the source checkout was not edited.

## Result

Current native issue assignments take precedence over historical hire deliverables.
Newer explicit lead reassignments win over older native assignments, using a
`deliverableAssignedAt` timestamp that ordinary messages cannot refresh.
Evidence-backed `fleet_efficiency` reviews can reassign the deliverable or report
`ownedIssues` for several live assignments, including native children and linked
fleets. Claims belong to the exact occupant and admitted lead; refused report
routes do not inherit historical efficiency claims. Running native child labels
naming exactly one issue count; ordinary messages, reports, completed children
and ambiguous labels do not confer ownership. The operator head's native children
are included even though that head is outside the worker roster.

Ownership observation completes before the daily check. An issue held by a live
child or a lead-reported assignment stays In Progress when a predecessor leaves.
Additional claims never authorize automatic settlement of child issues on exit.
Fleet review fingerprints and prompts include the explicitly reported issues.

Rebased without conflict onto fetched `origin/main` at
`cdd373cab41ca375c2bccea59cff1322ba8c6200` before submission.

## Checks

- Formatter run on every touched file; formatter check passed.
- Seven focused suites passed: **57 tests** covering keeper/Linear adapter,
  efficiency persistence and owner changes, authenticated review API, TUI consumer,
  native child history, fleet lead rounds and remote lead wakes.
- Final rebased seven-suite rerun after timestamp precedence was added: **57 tests passed**.
- The new precedence regression initially caught an unwired selector; fixed before
  the final green test/typecheck runs. The evidence retains that resolved failure.
- Clankie and TUI focused typechecks passed. No local full root gate or eval ran.
- `verification.json` retains the focused run output, check receipts and source snapshots.

## Live evidence and remaining gap

A read-only native roster was captured at **2026-10-11T06:37:23.584Z**:
**22 live seats**, including six linked-PC seats. A connected Clankie Linear
GraphQL snapshot enumerated **15 In Progress issues**, with no next page.
The `live-linear.json` section retains that issue snapshot; `live-replay.json` retains the
production keeper's read-only before/after replay and the exact ownership inputs.
The replay refused every tracker call except `list_issues`; no live tracker
status was changed by verification.

Both algorithms flag **11 issues** on this capture. The existing live service
has no explicit follow-up/native-current-issue claims for those rows, so this
capture does **not** establish that the remaining flags truly have no owner.
The October 10 false positives are no longer in this In Progress snapshot.
The implementation and acceptance-boundary tests are verified; the final live
acceptance criterion still needs deployment, evidence-backed claims from the
owning leads for their current follow-ups, and another live check. Do not mark
that criterion passed or close the issue on this replay alone.

The fleet-snapshot route timed out after 30 seconds; the direct roster route
succeeded. `/health` returned 200 and runtime status reported ready. No existing
lane was steered or restarted to collect evidence.
