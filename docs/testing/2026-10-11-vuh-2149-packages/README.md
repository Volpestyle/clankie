# VUH-2149 packages test pruning

Tracks: https://linear.app/vuhlp/issue/VUH-2149

Review and every deletion/merge reason:
[ADR 0221 inventory](../../adr/test-pruning-review.md#vuh-2149-packages-and-discord-bridge-slice-1).
Baseline: fetched origin/main `990a774a4cceaba7a5b3f6d2939d5529a70b8041`.

Slice 1 touches only Discord presence-core and bridge tests. Focused Vitest before:
271/271 pass; after: 262/262 pass. Voice-session remains 215/215, including both
native disconnect cases after the table merge. Retained bridge and user-session
shutdown consumers are included in both runs. No eval or live Discord operation.

All commands use `clankie heavy --`. The focused tests name voice-floor,
voice-session, bridge commands, bridge Vox ownership and user-session shutdown;
the deleted helper file is included only in the baseline.

- Typecheck: `pnpm exec turbo run typecheck --only --concurrency=1 --filter=@clankie/discord-presence-core --filter=@clankie/discord-bridge`.
- Dead code: `pnpm exec knip --workspace packages/discord-presence-core --workspace apps/discord-bridge --include files,dependencies,unlisted,unresolved,exports,types,enumMembers,namespaceMembers`.
- Lint and format: explicit changed test files; package lint also covers both touched packages.

An initial table merge failed TypeScript because destructuring separated correlated
event discriminants. Passing the intact row fixes it; no cast, assertion or
production change. The failed log is retained locally beside the final runs.

Raw check logs, JSON reports and the complete before/after static inventory are in
this worktree's `.local/vuh-2149-packages/`. Final slice 1 exits: focused tests 0, both package typechecks 0, scoped Knip 0,
changed-file lint 0, package lint 0 and format 0. These are focused gates, not a full landing gate.
