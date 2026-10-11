# Joined Claude seat — first slice

Tracks: [VUH-2128](https://linear.app/vuhlp/issue/VUH-2128).

Base: `4ffbc7eb3cfb684258643e47afc67e5f3ab4dce8`, verified against fetched `origin/main` before work. The tested implementation is in the commit containing this report; integration supplies the final exact-tree receipt.

The joined install resolves a home-owned workspace chat, launches its own Claude/plugin and carries delegated lead traffic inside the existing encrypted join exchange. It keeps the launch directory, home's maximum-trust setting and native session binding. No local service or SSH is involved. Plain launch reuses the machine/folder's chat; `--new` makes another; an exact selection must match that machine/folder.

Raw logs and compiler reports are bundled in `verification.json`, retained by the evidence manifest.

## Observed evidence

- `launch-and-boundaries.txt`: **38 tests passed in eight suites**. The new integration uses a real socket, approval/encryption, file broker, conversation store and MCP client/server. It verifies the home chat and transcript, a real `clankie prompt` subprocess reading the joined registration, delegated tools, channel wake/ack, maximum-trust launch arguments and bundled plugin/allowlist. Native Claude execution is observed at the spawn boundary. It verifies that chat/session/machine substitutions, occupied chats, portal downgrade and revocation refuse access, and that `start` on a joined install points to the home. Channel attachment works with the home's own machine ceiling at `portal`: the remote lead has its own workers consent.
- `consumers.txt`: **98 tests passed in eight suites**, covering MCP bridge, transcript sync, headless dispatcher, hosted routing, native seat capabilities and authenticated owner app turns.
- `types.txt`: the previously failing Clankie test compiler program and its transitive source consumers passed after the fixture's missing logger was fixed. Earlier TUI source and all four TUI test compiler programs passed. Earlier Clankie source and test programs 1–5 passed; those results predate the final scoped channel-admission change. The integration gate remains the exact-tree landing check.
- Touched files formatted; explicit source/test lint passed. Documentation links checked separately.

Focused commands (each through `clankie heavy --`):

```sh
pnpm exec vitest run apps/clankie/test/joined-seats.integration.test.ts apps/clankie/test/machine-join.integration.test.ts apps/clankie/test/remote-project-leads.integration.test.ts apps/clankie/test/operator-conversation-workspace.test.ts apps/tui/test/seat-command.test.ts apps/tui/test/seat-context-selection.test.ts apps/tui/test/seat-hook-fast.test.ts packages/settings/test/bundled-skills.test.ts
pnpm exec vitest run apps/tui/test/mcp-bridge.test.ts apps/tui/test/seat-sync.test.ts apps/tui/test/headless-captain.test.ts apps/tui/test/hosted-command.test.ts apps/tui/test/hosted-login-routing.test.ts apps/clankie/test/seat-capabilities.integration.test.ts apps/clankie/test/seat-input-capabilities.integration.test.ts apps/clankie/test/owner-app-seat-turn.integration.test.ts
node scripts/typecheck.mjs .local/typechecks/run-hUZxTy/tests-6.json
pnpm docs:check
```

## Gaps

No PC access, installer, native Claude UI, or production-gateway proof was attempted. Windows projection now copies plugin components instead of requiring symlink privileges; its native proof is still outstanding. Real PC proof needs `supedupsilly` and coordination through James before touching it; no installers there yet.

Joined resume/reset, old-pane reporting, migration of legacy SSH chats, other harness seats, joined worker adapters and standard Windows release/install/update remain later slices. Grants expire after one hour without traffic and are invalidated by home restart. Lost transport replies do not authorize replaying a tool call. This is first-slice evidence, not completion of all VUH-2128 acceptance criteria.
