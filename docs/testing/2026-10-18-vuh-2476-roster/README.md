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
- Landing gate result and retained logs: pending.

## Gaps

The app's device-session client is in the private app repo, outside this supplied
worktree. Its consumer must opt in using the documented query; the lead has the
contract for VUH-2472. No app UI, live deployment or main push was performed.
