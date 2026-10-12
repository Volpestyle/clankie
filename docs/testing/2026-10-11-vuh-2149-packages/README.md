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

## Final slice

Based on current main after `bf7fe53ec`: settings persona loses a repeated authority
sentence plus incidental introductory copy; addresses-character loses ordinary/
empty-input helper duplication already covered by real text ingress. Per-test
reasons and all assigned-area inventory counts are in the review doc.

Final slice: 2 → 2 test files; 134 → 123 lines; 14 → 12 runtime cases.
Focused before/after also includes retained text-ingress and model-provider cases:
120 → 118 passing cases. The config-path helper was considered but retained as
the only direct check of its documented absent-path return. Its file is unchanged.

Combined cuts: 6 → 5 touched test files, 129 lines and 11 runtime cases removed.
Complete static assigned-path inventory: 187 → 186 files, 46,862 → 46,733 lines,
1,610 → 1,598 test declarations. The extra declaration reduction is the merged
voice-session table: both original runtime inputs remain. Candidate review is
recorded, not an exhaustive claim about every unchanged test body. Protocol,
credentials, native identity, filesystem/grant fences, recorded regressions,
integration/golden cases and eval inputs are retained.

Final gates use `clankie heavy --`:

- Typecheck: `pnpm exec turbo run typecheck --only --concurrency=1 --filter=@clankie/settings --filter=@clankie/discord-presence-core`.
- Knip: the same issue types above, scoped to settings and discord-presence-core.
- Lint: both touched package directories; format-check names the two changed
  tests, the complete shared review log, this README and the evidence manifest.
- Focused Vitest: persona, addresses-character, text-ingress and the retained
  model-provider file, with JSON reports. Slice 1 evidence remains valid for
  its unchanged files and retained consumers.

## Formatting incident

[CI failed](https://github.com/Volpestyle/clankie/actions/runs/38201935046)
solely because the newly appended review tables were not formatted. A local
revert was prepared and withdrawn before any push when the lead directed a
format-only repair. `bf7fe53ec` formats the complete shared review log;
[CI passed](https://github.com/Volpestyle/clankie/actions/runs/38202293532).
The first slice's tested cuts remained on main. The final slice checks the whole
shared Markdown file. Three pushes total: first cuts, formatting repair, final cuts.

The archived `checks.json` contains logs (including the initial failed typecheck
and doc-format check) and runtime reports; the complete inventories and before/
after Vitest reports are separate entries in `evidence.json`. No full gate, eval,
release, live provider call or native service restart was run.
