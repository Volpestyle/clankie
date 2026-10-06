# Defaults-first project onboarding — VUH-1538

Rhea's core-only candidate, based on `origin/main` at `2acffdcf`, implements
James's 2026-10-06 13:11Z suggestion and Clankie's 13:26Z decision.
Branch: `rhea/vuh-1538-defaults-first`.

`propose_project_defaults` returns one persisted proposal: tracker, roles and
one-line reasons, fleet preference and numeric cap. Saved conventions win;
otherwise the existing work discovery reads Linear links/history/branches,
GitHub issues, and file trackers. Ambiguity produces one pending question.
Builder/reviewer are baseline; app UI adds designer and a suite adds tester.
Small is two workers; 1,000 source files plus 50 commits in 14 days can justify
four. The observed governor caps the proposal; unavailable/pressured resources
set zero workers. These defaults never acquire resource permits or hire agents.

The owner can accept the exact target (`project_proposal_confirm`, CLI
`accept-project`) or tweak one field (`project_proposal_tweak`, CLI
`tweak-project --field FIELD --value-stdin`). Tweaks prepare a replacement,
recheck owner/workspace/revision, persist a new hash/target and invalidate the
old target. They save no project or tracker. Rename failures disable the issuer
and cannot replay. Acceptance uses the existing `5963f561` / `44631868` durable
CREATE path and persists the confirmed roles used for stations. Tracker and
settings retain their existing separate file-write boundary.

Checks run through both the assigned legacy heavy wrapper and `clankie heavy`:

- [Boundary run](evidence/boundaries.log): 112 passed across eight files,
  covering original-owner authority, consumed claims, tracker initialization,
  signed local/hosted relay tweaks, strict schemas and existing CLI behavior.
- [Final inference/CLI run](evidence/inference-cli-live-github.log): 33 passed.
  Real temporary git repositories, on-disk settings and question metadata,
  native HTTP CLI tweak→accept, actual GitHub public HTTP reads, every inferred
  tracker path, competing trackers/teams/projects, roles, activity and resource
  caps. No substituted tracker, git, filesystem or HTTP responses in the new suite.
- [Five affected package typechecks](evidence/five-typechecks.log): protocol,
  work-items, service, relay and TUI passed. [Final core typecheck](evidence/final-core-typecheck.log)
  passed after the final new cases/source adjustments.
- [Formatter and scoped lint](evidence/style.log) passed.
  [Docs checks](evidence/docs.log) passed: local Markdown links and built public pages.
- The [initial failure](evidence/initial-failure.log) exposed that multiple
  Linear project links in one file were reduced to the first. The final run
  proves the correction; the initial failed run remains a failure.

Resource-cap sensitivity cases use the recorded 2026-10-06 governor snapshot
with explicit capacity/pressure scenarios. They prove proposal selection, not
native resource stress. Live GitHub reads are opt-in via `PROJECT_TRACKER_LIVE=1`;
ordinary runs keep provider traffic out of CI. Dependencies were installed with
`pnpm install --frozen-lockfile` in this worktree, with no shared directory links.

App confirm-card presentation and live model/iPhone/iPad station-growth
acceptance remain for the app redesign/integration. No app files, owner settings,
credentials, releases, simulators, evals or live model turns were changed/run.
The lead owns landing and issue closure.
