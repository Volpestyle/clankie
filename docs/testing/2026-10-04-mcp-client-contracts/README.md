# Strict native MCP catalog contracts (VUH-1651)

Validated in the isolated `feat/vuh-1651` worktree. No live service, harness session,
external account, push, deploy, or service restart was used.

- Real `pnpm install --frozen-lockfile`: passed, 579 packages installed.
- `pnpm mcp:check`: passed, 32 tests. This is the push/PR CI step in
  `.github/workflows/ci.yml`; local loopback HTTP and stdio only.
- Focused Vitest files (`lane-mcp`, `mcp-host`, `fleet-tools`,
  `hired-catalog-bridge`, `mcp-tool-schema`): 86 tests passed before the additional
  reference-normalization golden, which passed in the final contract check.
- `pnpm --filter @clankie/clankie typecheck`: passed.
- Oxlint on the eight changed service/test TypeScript files: passed.
- Narrowed `knip --workspace apps/clankie`: reports five untouched exports:
  `captainSkills`, `GrokSessionId`, `grokTuiOwnsSession`, `waitForGrokTuiSession`,
  `discoverGrok`. No new findings. The lead reports the full workspace check
  passed at `a4f17bee`, so these are treated as narrowed-workspace artifacts,
  not repaired as baseline debt.

The lane check builds the real authored registries for every current protocol
lane and reads the actual HTTP MCP endpoint. The fleet checks read its HTTP
catalog and spawn the shipped stdio bridge, including mailbox and peer tools.
A real subprocess provider returns healthy and rejected entries together;
the host retains the healthy callable tool and logs each rejected name/reason.
Negative goldens cover object roots, properties, required fields, output schemas,
metadata, annotations, icons, execution and Codex's recursive input conversion.

Client contracts: installed Claude Code 2.1.289 embeds the SDK 1.29.0 schema;
Codex 0.160.0's rmcp 3.2.0 wire contract and recursive schema normalization are
pinned by source links in `apps/clankie/src/mcp-tool-schema.ts`. These are
contract/integration checks, not a launched-client end-to-end test. A later
client upgrade needs review of those pinned contracts.

Follow-up coverage refinement: the same four lane wire checks now enable every
optional authored family (desktop, Minecraft, body leases, rivals, native agent
sessions, work items, runtime updates, file delivery, Discord bodies and stream
watch). This exercises their real definitions without executing the ports.
The final unchanged 32-test contract check passed in 6.84 seconds.
