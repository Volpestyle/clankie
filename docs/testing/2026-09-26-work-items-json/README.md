# Work Items JSON truncation — VUH-1374

The new regression reproduced James's exact error:
`Unterminated string in JSON at position 50000 (line 1 column 50001)`.
Work Items parsed the text returned by the MCP host, which unconditionally cut
it to the 50,000-character model-output limit.

## Fix and verification

- Internal callers can select `resultMode: "data"`. Complete results up to
  8 MiB UTF-8 pass through; larger results return typed `result_too_large`
  without content. Work Items maps that to `WorkRequestError` before JSON parsing.
  Default model calls retain the exact previous character cap. Lane and
  credential checks still run before either mode; data mode is not a model tool
  parameter. The limit applies to decoded result text, not transport buffering.
- Linear requests at most 50 issues per page and follows `cursor` while
  `hasNextPage` is true. It stops at the requested count of matching items
  (existing default 100 / maximum 250), or exhaustion. Filtering does not stop
  the scan at an empty matching page. Invalid continuation cursors fail explicitly.
- [Red](red.txt): six new cases fail, including the exact JSON crash.
  [Green](green.txt): 40 tests pass across five suites. Fixtures cover a >50k
  complete JSON page, >8 MiB multibyte text refusal, unchanged model truncation,
  multi-page limits, filtering, and missing/repeated cursors.
- [Real Linear read](live-proof.json): **165 issues in four pages (50/50/50/15),
  1.700 s**, through the changed service and real MCP host, not a fake transport.
  Page sizes were 39,908 / 39,489 / 39,342 / 11,914 bytes. Only metadata and sizes
  are retained here, not issue bodies. Clankie's account was checked with
  `get_user("me")` in the personal Vuhlp workspace. No tracker item was mutated
  for this read; the evidence comment is a separate authorized write.
- [Work-items package typecheck](typecheck-work-items.txt) passed. A scoped
  TypeScript check of the MCP host, service and new service regression passed.
- [Full check](check.txt) stopped on formatting in concurrently edited
  `app.ts`, `hosted-body.ts`, `hosted-device-security.ts`, and
  `restore-authority.test.ts`. [App-wide typecheck](typecheck-clankie.txt) also
  found unrelated hosted security edits. None of those files was changed here.

Commands:

```sh
pnpm exec vitest run apps/clankie/test/work-items-linear-results.test.ts packages/work-items/test/linear-pagination.test.ts apps/clankie/test/mcp-host.test.ts apps/clankie/test/work-items.test.ts packages/work-items/test/backends.test.ts
pnpm --filter @clankie/work-items typecheck
pnpm --filter @clankie/clankie typecheck
pnpm_config_verify_deps_before_run=false pnpm check
```

## Why the picker shows two clankies

[Live repo response](duplicate-repos.json) contains `workspace` (needs a decision)
and `clankie-3cac94e5` (Linear). They are different directories in the same Git
checkout, both with basename `clankie`:

- The pnpm-started body process has CWD `~/dev/clankie/apps/clankie`. No
  `captain.workingDirectory` is configured, so `index.ts` supplies that CWD as
  its implicit workspace. There is no tracking file in that directory.
- `~/.clankie/work-repos.json` registers `~/dev/clankie`; that root has the
  recorded Linear convention in `.clankie/tracking.json`.
- `known()` compares resolved paths literally, not their Git root. `describe()`
  reads the tracking file only in the supplied directory. The app displays the
  basename and backend label, so the two distinct IDs look like duplicate repos.

Verified with `clankie work repos`, the registry, settings and the actual body
process's CWD via `lsof`. This is a repo-root/implicit-workspace identity issue,
not two Linear connections. App UI and registry were left unchanged as requested.

## Delivery boundary

This validates the fix from checkout in tests and against real Linear. It does
not claim the already-running body or James's iPhone has loaded the new code.
No restart, deployment or push was performed.

The shared checkout's concurrent VUH-1383 commit `c206c18e` captured the small
Work Items service opt-in/error-mapping hunks while they were in flight. The
remaining MCP-host, pagination, regression and evidence changes are committed
separately; no shared history was rewritten.
