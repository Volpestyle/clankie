# VUH-1869: named worker grids

Source starts from fetched `origin/main` `052bb7661c5e14facc5da372182bbf3339183d08`
in the fresh `vuh-1869` worktree, with a frozen dependency install through
`clankie heavy`. The focused source checks and live allocation check passed.

Omitted placement fills four positions in a named group: top-left, top-right,
bottom-left, bottom-right; the fifth opens `group · 2`. `pipeline` overrides
its group name; otherwise the hire uses its proven project, deliverable, then
repository. Explicit `new-tab` preserves a solo tab and owner/role/fleet
preferences still win. No owner settings or existing panes are migrated.

Herdr splits leaves, so the sequence is right of the first pane, down from the
first, down from the second. That fills positions right/down/right while
keeping both columns equal. A `right` split of bottom-left would instead make
narrow panes inside the left column. Group/repo/grid metadata plus observed
geometry prevents adoption of unrelated or altered tabs.

Prepared native initial-command panes start in their own temporary tab and
move only that new pane into the grid. The terminal/process remains intact,
and the temporary tab closes automatically. Failed creation, move or metadata
receipts remain uncertain and are not retried with another allocation.

The canonical lead guide is now `.agents/skills/lead/reference/fleet-tools.md`;
the issue's old generated `lead/reference/operations.md` path no longer exists.
Both that guide and the worker skill link exact
[worker commands](../../../.agents/skills/clankie/reference/worker-layout.md),
including the same-tab move no-op and owner-authorized out-and-back workaround.

Completed verification:

- Real Herdr CLI/socket journey with temporary Git repos/worktrees, native
  initial-command allocation, five-pane grid geometry and overflow, recreated
  runners, unrelated lanes, uncertainty fences and private-session cleanup.
- 179 covering tests passed across eight hire/fleet files (15.53 s), including
  the real-socket journey. Clankie/protocol typechecks, targeted formatting/lint,
  568 Markdown link checks and retired-claim checks passed.
- Live running-session allocations using only five throwaway panes created
  for this check; geometry, names, focus and existing pane identities preserved.
  This proves the hire-layout allocation path, not five authenticated model
  turns or service deployment. No existing owner pane is rearranged.
- Live same-tab no-op and out-and-back move on a throwaway pane, with native
  shell PID preserved; cleanup of only the owned test panes.

[Live evidence](live.json) records the five allocations at 2026-10-09 02:50:50 UTC:
`w47:tK` held four panes; `w47:tM` held the fifth. Both tabs were named for the
test group. The full grid measured 272 × 71 cells, with two 136-cell columns
and 36/35-cell rows. All 12 pre-existing panes retained their workspace, tab and
terminal identities; global focus was preserved. The out-and-back move kept
shell PID 6446. Cleanup left zero owned panes and zero owned tabs.

The [private journey](private-journey.json) records geometry, mutation counts,
uncertain-receipt cases and cleanup. Its prepared initial-command assertions
also verify that terminal and process IDs survive the new-pane move.
The [live runner](live-runner.ts.txt) is archived for reproduction; its full
trace excludes unrelated workspace snapshots and worktree inventories.

Two initial live attempts failed in my evidence helper: it tried to decode a
successful empty `report-metadata` reply as JSON. Both allocations were
reconciled and removed before the corrected check. No live-server change was
needed. The initial source journey also exposed the remote transport's missing
`pane move` allowlist entry; the completed tests cover its admission while
server-control verbs remain blocked.

Scope: five live allocations through the actual hire-layout path, not five
authenticated `hire_agent` model turns. The prepared-launch journey and covering
hire tests verify forwarding and native launch boundaries. No deploy, live
settings write, existing-pane rearrangement or model dispatch occurred.
