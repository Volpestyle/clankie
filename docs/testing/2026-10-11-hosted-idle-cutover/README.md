# VUH-1756: idle cutover after staging

Tracks: https://linear.app/vuhlp/issue/VUH-1756

Source `6d123e7c3`. Public repository / Mac-local only; no tenant wakes, ops
deployment, approval changes or release publication.

The detached helper downloads and verifies a Linux-layout release through a real
loopback HTTP archive server. During the response, a real body activity turn
starts (or the settings store disables automatic installs). The helper calls the
operation- and boot-bound cutover API through the CLI consumer. Both cases retain
the staged directory without stopping services or switching `current`. After
work finishes and installs are enabled, a new scheduled check becomes healthy
using the same stage: one archive download across both attempts. Late turn
admission is refused after ready; work beginning during the native-agent census
also keeps the body busy. Wrong authority/operation/boot and unavailable cutover
fail closed. The fixture controls supervisor receipts; no managed tenant runs.

All 60 focused tests across seven files passed. Formatter, format check, scoped
lint, public docs and local TUI/body package typechecks passed. The integration
service supplies the final exact-tree landing gate; local compiler logs predate
the final CLI fixture coverage additions.

```sh
clankie heavy -- pnpm exec vitest run apps/tui/test/release-update.integration.test.ts apps/clankie/test/scheduled-update-idle.integration.test.ts apps/clankie/test/runtime-provider-loader.integration.test.ts apps/clankie/test/runtime-provider.integration.test.ts apps/clankie/test/hosted-body.test.ts apps/tui/test/update-command.test.ts apps/tui/test/owner-updates-cli.integration.test.ts
```

Managed rollout/approval and live hosted verification remain VUH-1757, requiring
lead authorization. VUH-2005 remains paused for PC proofs.
