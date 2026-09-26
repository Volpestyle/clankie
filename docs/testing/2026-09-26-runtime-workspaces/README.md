# Runtime workspaces and owner capacity — 2026-09-26

[VUH-1377](https://linear.app/vuhlp/issue/VUH-1377) implements
[ADR 0193](../../adr/0193-runtime-workspaces-are-owner-approved.md).
Upstream commits: `672eb6f` (workspace routing), `6637756` (nullable budgets).
The vendored source is exactly `e93dc70` plus those two commits.

## Verified behavior

- Repository approvals include registered linked worktrees, including checkouts
  outside the repository directory; plain directory grants match exactly.
- Deleted grants confer no authority, produce stale-workspace diagnostics on
  rejected requests, and do not block valid parent-directory dispatch.
- Actual launch and enrollment use the requested canonical directory while
  retaining requester coordination scope and immutable intent fingerprints.
- MCP assignment output preserves requested path and per-route diagnostics.
- Operator CLI/API persists policy; captain/Discord credentials are refused.
- Default runtime capacity and coordinator budget are 16. Status distinguishes
  default, owner-set and explicit unlimited values. Limits have no product ceiling.
- Sixteen real coordinator dispatch intents remain in flight; the seventeenth
  is blocked. Lower limits apply without reprovisioning. Clearing both limits
  admits additional work. Earlier uncertain receipts are recovered without
  launching duplicate workers.

## Checks

| Check                                                 | Result                                              |
| ----------------------------------------------------- | --------------------------------------------------- |
| Upstream typecheck                                    | Passed                                              |
| Upstream tests                                        | 188 passed; Python hook test passed                 |
| Fresh-clone build and `npm run verify:package`        | Passed                                              |
| Focused Clankie integration tests                     | 26 passed across 5 files                            |
| Clankie workspace typecheck                           | 27 tasks passed                                     |
| Formatting of this change's files                     | Passed                                              |
| Clankie lint, documentation and infrastructure checks | Passed                                              |
| Whole-checkout `pnpm check`                           | Blocked at formatting by other-lane work-item files |
| Whole-checkout deadcode                               | Three other-lane temporary files                    |

`bun run check` completed upstream tests and build, then failed in package
verification because its inherited `npm_execpath` points to Bun, which the verifier
attempts to execute through Node. The same verification passes under npm in the
fresh clone. No source or package verification failure was suppressed.

Whole-checkout formatting blockers were `apps/clankie/.work-discover.mts`,
`apps/clankie/.work-proof-serve.mts`, and the other lane's
`docs/testing/2026-09-26-work-items/{evidence/*.json,flows/serve.mts}` (24 files).
Deadcode flags the two temporary scripts and `flows/serve.mts`. Those files were
left with their owner.

## Artifact and migration

Built and packed from a fresh clean checkout at `6637756`, with no inherited
`dist` directory. Artifact SHA-256:
`bb22a38ea6ba3a944f043eadef7ab879a96bcf0e060c40b810a049078c0f8d9a`.
Verified `mcp-cli.js`, `owner-cli.js`, `herdr-worker-cli.js`,
`claude-hook-cli.js` and the bundled skill exist; the skill no longer references
removed `references/legacy-workflow.md`. Legacy CLI/cutover removals inherited
from `bf910a1` and `e93dc70` are recorded in vendor provenance.

[Migration proof](migration-proof.json) contains only counts and comparisons.
Both live schema-13 databases were captured using SQLite's online backup API,
then separate private copies were migrated to schema 14. Every original column
and row across every original table was preserved, including five tasks and five
dispatch intents. Integrity checks passed and foreign-key checks were empty.
The migration code tested at `672eb6f` is unchanged in `6637756`.

No live owner was upgraded. Snapshot preservation does **not** prove active
worker leases survive a running upgrade. The launch lead must finish the active
workers, refresh online backups immediately before the coordinated restart,
and run the native-seat flow. Old binaries reject schema 14: rollback requires
restoring the pre-upgrade snapshot and reconciling later work, not binary reversal.
VUH-1344's legacy migration/rollback acceptance remains an upstream decision.
