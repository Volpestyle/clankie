# Parent relationship producer examples

- `linear-issue.json` retains selected fields from Clankie's connected
  `linear_get_issue({ id: "VUH-1593" })` read on 2026-10-04. The live
  `linear_list_issues` schema also exposes `parentId` in `fields`; a selected-field
  list read returned `VUH-1533` with `parentId: "VUH-1530"`.
- `github-parent.json` retains the fields used here from GitHub's official
  [Get parent issue response example](https://docs.github.com/en/rest/issues/sub-issues#get-parent-issue),
  checked on 2026-10-04. The producer is a parent Issue from
  `GET /repos/{owner}/{repo}/issues/{issue_number}/parent`, not an inline parent
  on a normal issue read. Local HTTP tests serve this golden and explicit 404/503
  responses through the production REST adapter; they are not a live GitHub test.
- `T-12-child.md` is sample owner-authored Markdown with the documented scalar
  `parent:` front matter and a different prerequisite. Tests read it through the
  real filesystem backend, then exercise an unrelated update.

These fixtures and the integration tests prove producer-to-work-item-to-response
schema boundaries. They do not claim live app rendering or remote tracker writes.

The old client schema is the unmodified
`packages/protocol/src/work-items.ts` from commit `8d982a93`, frozen in
`packages/protocol/test/fixtures/work-items-8d982a93.ts`. Compatibility uses the
production `parseProtocolResponse` reader against that schema, not a reconstructed
old shape.
