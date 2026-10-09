# Workspace sync discovery — VUH-1964

The additive Sync 1 amendment routes project and project-level cycle/release
metadata through the always-subscribed `workspace` group. Full wildcard bootstrap
expands every tracker project UUID plus `unprojected` and `workspace`. Partial
bootstrap selects exactly the named UUIDs; names are refused.

## Inspected integration proof

Command: `clankie heavy -- pnpm exec vitest run --config vitest.config.ts apps/clankie/test/tracker-sync.integration.test.ts`.
Result: exit 0, 1 file and 6 tests passed, 3.82 seconds, 2026-10-09.
Raw output: `.local/workspace-sync-tests.log` in the owned server worktree.

The new discovery integration uses a real journal, signed paired device, host and
relay HTTP. It checks exact wildcard groups including a canceled project and an
unprojected issue; a new project and cycle arrive through workspace without issue
bodies; an existing-project-only subscription still discovers the new project;
partial bootstrap contains exactly the discovered project's UUID and item; adding
that UUID receives a later issue edit; workspace receives project rename/status
changes; project-name bootstrap is refused. The existing five integration cases
also pass, covering keyed replay, authority, resume, project moves and atomic gates.

Milestones remain reserved in this base; no milestone records or archive operation
exist yet. Project field deltas use workspace generically, and the ADR records
milestone/archive routing when those records and operations are supported.
VUH-1963 was absent from fetched main at the amendment's initial verification.

## Landing

The required root `pnpm check:landing` runs after commit and rebase against fetched
`origin/main`. Its checked HEAD, fixed base and outcome are recorded in the issue's
landing comment; local raw output and report are `.local/workspace-sync-landing.log`
and `.local/landing-gate.json`. No deployment or shared-checkout changes.
