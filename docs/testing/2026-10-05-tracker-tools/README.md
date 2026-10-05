# VUH-1665 tracker interface evidence

2026-10-05. Design: [ADR 0226](../../adr/0226-one-tracker-tool-surface.md).
The candidate exposes one Linear-shaped catalog with owner-connected Linear,
durable local storage, and explicit repository adapters. `clankie work` and
receipt-backed device writes remain compatibility callers.

The two new boundary suites pass **7 tests** through the real fleet HTTP/MCP
surface, host, settings, credential store and tracker storage. They prove:

- Offline issue/project/label/state operations, every description patch shape,
  atomic patch refusal, hierarchy, relations, comments/replies and project updates.
- Stable IDs after reopening storage, concurrent writes, publication-time fleet
  revocation, and no local replay after a connected transport failure.
- Saved Linear repo conventions and unchanged issue-ID worker calls, including
  replies; ambiguous IDs refuse without writes or repository enrollment.
- Markdown CLI/tool agreement, priorities, and preservation of owner prose and
  uploaded-media Markdown during patch and priority-only edits.
- Connected priority ordering across provider pages through a controlled local
  MCP provider, including native priority objects. No provider mutations occur.

Focused regression run: **14 files, 109 tests passed**:

```sh
pnpm exec vitest run \
  apps/clankie/test/tracker-tool-surface.integration.test.ts \
  apps/clankie/test/tracker-connected-priority.integration.test.ts \
  apps/clankie/test/mcp-host.test.ts \
  apps/clankie/test/worker-mcp.test.ts \
  apps/clankie/test/work-items.test.ts \
  apps/clankie/test/work-items-linear-scope.test.ts \
  apps/clankie/test/work-item-write.integration.test.ts \
  apps/clankie/test/linear-write-receipt.test.ts \
  apps/tui/test/install-doctor.test.ts \
  apps/tui/test/work-command.test.ts \
  packages/work-items/test/backends.test.ts \
  packages/work-items/test/parent.integration.test.ts \
  packages/work-items/test/write-deltas.integration.test.ts \
  packages/work-items/test/linear-pagination.test.ts
```

Affected package typechecks passed: `@clankie/protocol`, `@clankie/work-items`,
`@clankie/clankie`, and `@clankie/tui`. Changed-file lint and formatting,
documentation links, retired-claim checks and diff whitespace checks passed.
Both native seat instruction projections were regenerated.

The retained [cross-process local smoke record](local-core-evidence.json)
proves 40 unique issues from four concurrent Node processes, priority ordering,
patch operations, stable reopening and unchanged bytes after a failed fence.
This is supplemental smoke evidence, separate from the 109-test run.

Tests use temporary local state and controlled loopback providers. They never
write to the real Linear workspace. No full `pnpm check`, evals or sign-ins ran.
Pell owns the batch gate and landing; production rollout is not claimed here.
Export/import execution is deferred by acceptance; its account mapping,
identity mapping and receipt reconciliation are designed in ADR 0226.
