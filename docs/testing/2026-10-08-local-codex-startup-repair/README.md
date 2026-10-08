# Original local Codex startup repair (VUH-1739)

## Live trace

The deployed `0a4d20f9` fleet refresh at about 11:34:30Z reported three
distinct failure classes. This change addresses the local confirmed-startup
failure and adds native evidence to local refusal receipts. It does not deploy
or restart Clankie, alter existing panes, or run the operator refresh tool.

A read-only connection to Teo's original controller (PID 62224, pane w47:p4,
thread `01a119a3-1214-7241-a1cb-d6b60eede318`) found one loaded idle root.
`mcpServerStatus/list` filtered by that exact thread and `clankie` returned
`runtimeStatus: failed`, no tools, and:

```text
MCP startup failed: Mcp error: -32000: Clankie's initial tool catalog is unavailable after 20000 ms: Fleet tools/list timed out within its 30000 ms request budget
```

The durable original refresh generation recorded `writeConfirmed: true`,
`reloadConfirmed: true`, and `verified: false`. The coordinator routed every
subsequent attempt to catalog verification of that failed generation. It could
neither verify nor repair it. Wren's original runtime reported the same startup
failure; Wren was active at inspection, so busy deferral still applies.

The fresh w47:p8 seat's earlier `independent_codex_loaded_root` refusal is a
different observation. Its hire at about 11:34:10Z preceded that refresh by
roughly twenty seconds. Later inspection found only the original loaded root
and all six Clankie tools. Startup timing is a plausible explanation, not a
proven cause: the earlier native inventory was not retained. The independent
root fence remains intact; receipts now include the inventory needed to
diagnose a future refusal. The native integration test exercises a genuinely
independent loaded root and requires refusal before any config mutation.

The five PC `original_remote_codex_registration_unavailable` results belong to
[VUH-1742](https://linear.app/vuhlp/issue/VUH-1742), which owns original remote
controller recovery and private configuration provenance. Local busy seats
continue to return `skipped-busy`.

Private raw observations and earlier handoff receipts stay in the worktrees'
ignored `.local/vuh-1739-live/` directories. The public record contains only
the relevant native facts above.

## Repair and fences

A complete, unambiguous native status can distinguish failed startup from an
unknown catalog. When both earlier mutations were acknowledged, the controller
identity, idle loaded scope, current config version and effective transport
revision still match, and every unverified runtime reports `failed`, a new
attempt may install a fresh transport revision and reload. The confirmed
failed generation is archived before its journal is superseded. This is a
new guarded repair, not a retry of an uncertain mutation or tool call.

Read-only reconciliation, lost acknowledgments, unknown/starting/disconnected
status, a connected wrong catalog, independent roots, config drift and lost
authority do not gain repair permission. Original-thread native catalog reads
now have thirty seconds for startup, rather than the two-second metadata
deadline. Status errors and missing/unexpected tools appear in the bounded
`detail` field of API, CLI and operator receipts.

## Verification

The explicit native test launches an owned installed Codex app-server, the
shipped worker stdio bridge, and an owned SDK HTTP MCP catalog server. It uses
private temporary configuration and an offline model provider; it starts no
model turns. Only process/pane authority is a fixture. Config/read provenance,
native write acknowledgments, runtime reload/startup, status and tool inventories
come from the real Codex binary.

```sh
CODEX_CATALOG_NATIVE_TEST=1 clankie heavy -- pnpm exec vitest run apps/clankie/test/local-codex-catalog-native.integration.test.ts
clankie heavy -- pnpm exec vitest run apps/clankie/test/local-codex-catalog-coordinator.integration.test.ts apps/clankie/test/codex-tool-catalog.test.ts apps/clankie/test/worker-tool-refresh.integration.test.ts
clankie heavy -- pnpm check:landing
```

The native test requires same-thread repair after failed startup and coordinator
recreation, read-only reconciliation, a retained failed generation, a fresh
transport revision, all six peer-inclusive tools, and no report/tool call. Its
successful catalog deliberately takes longer than two seconds. A second case
requires an independent-root refusal with both native IDs in `detail` and no
mutation journal. The protocol/filesystem integration suite additionally
checks lost acknowledgments and unverified statuses never receive another
write/reload.

On installed Codex 0.161.0, both native cases passed (2/2), including the
deliberately slow successful startup. The focused protocol, catalog and real
HTTP/CLI suite passed 52/52. Landing-gate results are recorded on the issue.
Live acceptance remains with Clankie:
deploy the landed commit, refresh w47:p4 at idle through `refresh_worker_tools`,
and observe the original thread's tools plus a distinct new stored native report.
