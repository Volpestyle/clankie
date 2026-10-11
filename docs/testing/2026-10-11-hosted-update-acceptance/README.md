# VUH-1756: scheduled acceptance and newer image seeds

Tracks: https://linear.app/vuhlp/issue/VUH-1756

Source `936f99ce0`, based on fetched main `3ad47ee8e`. Public/Mac-local only.
The existing archives/provider API/release-root/approved-cap implementation
already landed October 6–7; v0.4.4 publishes both Linux targets/checksums.

Real loopback release-server and Linux-layout checks first reproduced three
failures: a busy body and a disabled schedule were accepted after release lookup;
a newer image seed was scheduled for downgrade to an older fleet approval.
After the fix all 55 focused tests across six files passed. Acceptance rechecks
enabled/idle state; refusal leaves no stuck lock, and explicit approved operator
pins still permit rollback. Scheduled latest keeps a newer seed.

Formatter and scoped TypeScript lint passed, exit 0. Tests ran through
`clankie heavy`; no tenant wakes, ops deployments, fleet approval changes or
release publication. Integration supplies the exact-tree gate.

Reproduce:

```sh
clankie heavy -- pnpm exec vitest run apps/tui/test/release-update.integration.test.ts apps/clankie/test/scheduled-update-idle.integration.test.ts apps/clankie/test/runtime-provider-loader.integration.test.ts apps/clankie/test/runtime-provider.integration.test.ts apps/clankie/test/hosted-body.test.ts apps/tui/test/update-command.test.ts
```

Remaining public gap (lead-approved follow-up in this issue): after download and
staging, check enabled/idle again immediately before stopping services. If busy,
retain staged release and retry at the next idle window. Prove work starting
during a slow download. This slice closes lookup→acceptance only.
Managed rollout/approval remains the separate ops half VUH-1757.
