# #265: a landed hire’s close removes its worktree

Proof on the owner’s Mac using source in PR [#276](https://github.com/Volpestyle/clankie/pull/276), with two real idle Claude 2.1.316 TUIs in a private Herdr server sharing one owned, detached worktree at fetched `origin/main`. No model turn, live service update/restart, owner pane control or removal of anyone else’s worktree.

Command (explicit manual-only proof):

```sh
CLAUDE_NATIVE_CONFIG_DIR=/Users/james/.claude-james CLOSE_LANDED_NATIVE_TEST=1 clankie heavy -- pnpm exec vitest run apps/clankie/test/close-landed-worktree.native.integration.test.ts
```

Observed result:

- The first close ran `PaneTidy.close`, closed its real pane, and kept the checkout with `reason: live_pane` while the other native Claude used it.
- The last close ran the connector’s `createHerdrSessionSource.close` → operator `close_seat` → production Herdr close → guarded `pruneTidyWorktree`. The strict protocol accepted `closed: true`, `worktree.outcome: removed`, `freedBytes: 63881216`, `branchDeleted: false` (detached HEAD), and `discarded: [node_modules]`.
- The adapter’s text reported the removed path, estimated bytes freed, and preserved evidence path. Filesystem and Git inventory confirmed the directory and its registration were gone. The retained `REPORT.md` was read back and the regenerable-trash sweep completed.

The proof binds its own native sessions to the real hire journal and calls production close paths in process. It does not run the relay’s external MCP transport or a model-driven hire turn. CI’s real-app run covers service boot separately. The existing MCP transport checks remain in the focused verification.

Earlier proof attempts correctly refused unstyled input (the harness inherited `NO_COLOR=1`) and protected a tree nested under a live main-checkout cwd. The final harness explicitly enables terminal styling, uses its onboarded native profile, and locates its owned tree outside that shared parent; production draft, pane and process guards remain intact. A temporary settling retry was removed after identifying that protected-parent cause.

Focused real-Git cases also exercise merged branch deletion, evidence preservation, another live pane, explicit `unlandedReason`, and a thrown prune failure with successful close. Existing close suites passed 74 checks before adding those four cases. Clankie source and all 16 test typecheck shards passed; final checks are recorded on the PR.

`freedBytes` estimates allocated bytes removed, excluding retained evidence; APFS shared blocks may free less physical disk. Discarded caches use the existing asynchronous sweep.

Raw native results, the exercised proof source, private-Herdr log and compiler report: [evidence blob](clankie://evidence/sha256/a404e5021c5ea474534ff24f86bb314cc19a991b2026cb1e379ef93412a8fa80).
