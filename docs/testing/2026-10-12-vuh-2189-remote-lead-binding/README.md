# VUH-2189: remote lead binding survives grant changes

Tracks: [VUH-2189](https://linear.app/vuhlp/issue/VUH-2189).
Base: `9049755b2f722625500ac091c5c41d48177cce4f`.

The integration proof runs a connected MCP client through the real remote-lead
HTTP bridge, launch/delegation store, conversation store, settings store,
machine access policy and exact-directory grant checker. It adds, removes and
restores an unrelated workspace grant, lists tools and dispatches a tracker read
through the same client after each change. Removing the lead's own cwd refuses
both retained authority and HTTP admission with `remote_lead_workspace_revoked`
and a fresh-launch recovery instruction. Changes to machine, SSH, session and
enablement return `remote_lead_binding_unavailable` with the same recovery.

- **Before:** restore only the old whole-connection hash, retaining the new proof.
  The first grant addition fails admission with `remote_lead_binding_unavailable`.
  Capture: [before.log](evidence/before.log) (expected exit 1).
- **After:** restore the identity-only hash and run the integration proof plus
  the existing delegation boundary checks: 5 tests passed in 2 files.
  Capture: [after.log](evidence/after.log) (exit 0).
- Explicit touched-file formatting and lint checks:
  [format-lint.log](evidence/format-lint.log) (exit 0).

These small text logs stay in git; `clankie evidence push --issue VUH-2189`
reported no upload candidates under its 16 KiB raw-file threshold.

Commands run through `clankie heavy`:

```sh
pnpm exec vitest run apps/clankie/test/remote-project-leads.integration.test.ts
pnpm exec vitest run apps/clankie/test/remote-project-leads.integration.test.ts apps/clankie/test/remote-lead-delegations.test.ts
```

This is integration evidence on the Mac. Native Windows observation, framed SSH
launch and tracker-provider dispatch use the existing fixture seams; this is
not a deployed Windows end-to-end claim. No live settings, credentials, PC or
KH2 head were touched. Deployment and the owner-requested KH2 relaunch remain
with the lead/owner. Delegations issued with the old hash need a fresh launch;
the fix does not migrate them or relax native process identity.

Landing uses `clankie integrate run SHA --push --no-wait`; its exact-tree root
landing gate and push receipt are separate from these focused checks.

## Default profile and compiler follow-up

The first integration batch `808c11ec-9c6c-4fb2-886f-c2c65b7382c6` failed its
root gate (exit 1): `remote-lead-delegations.ts(14,15): TS1294`, because the
service enables `erasableSyntaxOnly` and the refusal constructor used a
parameter property. The follow-up uses a plain declared field and assignment.
This is a failed landing gate, not a green full gate.

The existing profile-selection integration proof now selects bare `~/.claude`
for `account: "default"` when `~/.claude-default` is absent, even with another
signed-in profile selected by the environment. An existing explicit default
directory is preferred; an unfinished explicit profile refuses instead of
using the signed-in bare profile. Missing-profile errors name `~/.claude` and
its actual sign-in command. These are temporary profiles and native CLI fixtures
on the Mac; no live credentials, PC profiles or KH2 head were changed.

- Profile/setup/bridge checks: 4 tests passed, exit 0.
  [Captured summary](evidence/followup-profile.log).
- Post-fix binding/delegation checks: 5 tests passed, exit 0.
  [Capture](evidence/followup-binding.log).
- `clankie heavy -- pnpm --filter @clankie/clankie typecheck`: exit 0;
  source and all 13 test programs passed.
  [Archived compiler report](clankie://evidence/sha256/2c1a15196e4f5afc23b30fefe1a9e42799c66865c6dcd2fc7e0d5905a9ceb541).
