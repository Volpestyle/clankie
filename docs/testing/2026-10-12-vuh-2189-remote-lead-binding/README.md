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
