# VUH-2476: roster project and task

Tracks: https://linear.app/vuhlp/issue/VUH-2476

Candidate branch: `vuh-2476-roster-project-task`, based on fetched
`b931e69d6ef0bd983d67f254b290b78cdcf99d3a`.

`GET /v1/fleet/roster?includeWork=true` adds nullable confirmed project and
assigned task, plus hired/owner/unowned ownership. Legacy reads retain their
strict v1 shape. CLI and core API-client opt in. No new Linear reads or caption
parsing. Issue titles remain null because this roster has no cached title source.

## Verification

- Focused real fixture: `clankie heavy -- pnpm exec vitest run apps/clankie/test/fleet-project-membership.test.ts apps/clankie/test/lead-roster-device.integration.test.ts apps/clankie/test/fleet-roster.integration.test.ts` — 3 files, 63 cases passed.
- The native-cwd fixture uses a real child process and production native cwd
  observation, saved project settings, the membership service and roster work
  projection. It rejects a replacement occupant even with matching display text.
- Production app/device authentication, core API-client and CLI transports prove
  nullable fields, legacy strict parsing and visitor/support refusals. Existing
  fixture host transports remain deterministic; this is not deployed fleet proof.
- Core landing gate initially caught two `TS2322` errors in the new test
  transport adapters. Async adapters correct their promised return type;
  the initial failed report is retained alongside the final result.
- App device-session real-HTTP fixture: 4 cases passed against core `f8630e0ba`.
- App `clankie heavy -- pnpm check:landing`: exit 0, 104.97 seconds, on
  `17ddc0ef98a9478950f6311a2250a72e7c493355`, based on app
  `2f63ef78d98b1c99e46981c5fbab9a9efc10d306`. It ran in an isolated real
  sibling clone pair, with private installs and the exact core commit above.
- Final core gate result and raw logs are retained in the evidence manifest.
  The issue comment names the tested implementation revision separately from
  any later evidence-only commit.

## Gaps

The app consumer is committed on `vuh-2476-roster-work-client` at
`17ddc0ef98a9478950f6311a2250a72e7c493355` in the lead-assigned
`~/dev/clankie-app-wt/vuh-2476` worktree. Protocol uses `workspace:*`, with no
vendored schema/version pin. Core must land and deploy before this app patch.
No app UI, live deployment, native build or main push was performed; integration
and deployment remain the lead's work. Issue titles remain null because the
roster has no cached title source; no new tracker poll/cache was added.
