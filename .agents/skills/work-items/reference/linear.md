# Linear

Linear specifics for [work-items](../SKILL.md). Discover the actual tool schemas
before using the examples: unprefixed names refer to the `linear-server` MCP
outside Clankie's fleet; inside it, use Clankie's qualified `linear_*` tools,
which take the same shapes.
Use the workspace/account selected by the task and verify the authenticated
actor before a write.

In Clankie's confirmed fleet, load `clankie`. Admitted linked panes discover
verified connected-account tools with `clankie_tools` and invoke them with
`clankie_call`; no short manual grant/revoke cycle is needed for ordinary fleet
access. Persona-bound worker publishing still needs an exact grant or the lead.
Missing tools do not authorize a harness's independent Linear connector. A Herdr
environment variable or executable alone does not establish fleet admission.

## Mechanics that destroy data quietly

- **`labels` replaces the entire set.** Any label you omit is removed. Read the
  current labels, then resend the full list plus your change. Relation params
  (`blocks`, `blockedBy`, `relatedTo`, `links`, `addReleases`) are append-only
  and safe to send alone.
- **Paginate everything.** `list_issues` and `list_comments` cap at 250 per page
  (default 50). Keep calling with `cursor` until it's absent. A project that
  "has 47 issues" on one page may have hundreds.
- **UUIDs vs names.** `milestoneId` and `statusUpdateId` require UUIDs — resolve
  them via `list_milestones` / `get_status_updates` first. Projects accept names,
  identifiers, or slugs; issues take IDs or `ABC-123` identifiers; documents take
  IDs or slugs.
- **Unknown labels are rejected.** Label names must match exactly; `save_issue`
  errors rather than creating them.
- **`Duplicate` needs the relation first.** `save_issue` with `state: Duplicate` and
  `duplicateOf` in one call is rejected ("Issues can only be moved to a duplicate
  state when a duplicate issue relation exists"); send `duplicateOf` alone, then
  the state.
- **`save_status_update` replaces the full body.** Read it immediately before
  the write and change only the intended segment — this is how a living deploy
  runbook gets its checkboxes ticked without losing the rest.
- **Fenced project heads cannot expand relations.** A remote project head fenced
  to its tracker project gets
  `remote_lead_tracker_project_denied` for `includeRelations`: omit it, take the
  parent from `parentId` and list sub-issues with `list_issues` by `parentId`.
- **`save_release` into a completed stage can change every attached issue.** Treat
  it as a release action needing authorization for that bulk effect.

## Uploaded media is not round-trip safe

Read responses are not safe to send back verbatim for uploaded video nodes. A
playable video comes back from `get_*` as
`[demo.mp4](https://uploads.linear.app/...?signature=...)`; sending that text
unchanged through `save_*` downgrades it to a file card.

- Prefer patch-capable saves (`save_issue` and `save_document` take `patch`;
  `save_status_update` doesn't) so untouched media nodes stay untouched.
- Never write back the temporary `?signature=...` query a read returned. Strip
  the query string and save the stable `https://uploads.linear.app/...` asset
  URL.
- Write or recover an inline video as `![demo.mp4](<stable asset URL>)`.
  `[demo.mp4](...)` renders a file attachment instead of a player.
- If the asset must be recreated: download it while the signed URL is valid,
  run `prepare_attachment_upload` (it returns the stable `assetUrl` plus the
  signed upload request) → raw PUT with the exact returned headers →
  `create_attachment_from_upload`, then embed that `assetUrl` with `![](...)`.
- Check `prepare_attachment_upload`'s schema for a project or status-update
  target before uploading media for a status update. If it takes only an
  issue, use the closest relevant issue as the hosting anchor, finalize the
  attachment there so the asset persists, then embed its stable `assetUrl` in the full status body.
  The attachment is visible on that issue, so choose the anchor deliberately.

## Threads

Answer an owner's comment in its existing thread: pass the wake's `replyParentId`
(or `commentId`) as `parentId`, together with `issueId`, `projectId` or
`statusUpdateId` (the wake's `projectUpdateId`). A reply to a reply resolves to
the thread root. When relaying a comment to another worker, include its comment
ID and target so they can answer in the same thread. Wakes, routes and the
request budget: the `this-machine` skill's Linear reference.

## Worker results

With a verified Clankie Linear app connection, publish a worker's result using
`linear_create_worker_comment` (or `clankie linear post comment --json-stdin`
from the operator seat), with its existing fleet `personaId`, `issueId` and
`body`. The service derives the worker's name and colored portrait. This is one
app identity, not an email alias or a separate Linear member. A worker bridge
grant must pin the exact `personaId`; without that grant, send the result to
the lead to publish. Never substitute an inherited personal tracker connector.
For setup and supported paths, read `docs/linear-worker-posts.md` in Clankie's
repository or the worker-posts section of the CLI reference.

## A repo label as the board

When the owner's Linear convention uses an existing repo label, record it with
`clankie work init --backend linear --linear-team KEY --linear-project NAME
--linear-label LABEL` (the project is optional), or `linearLabel` on
the compatibility HTTP init request. This saves `linear.label` in the convention.
The board then includes only issues with that label; `list --label designer`
intersects it with the role, status and owner filters. New items carry the saved
label. Omitting the saved label keeps the existing team/project-wide board;
direct `show ID` reads are unchanged. Choose an existing label under the owner's
authorization; the command never creates labels or selects another account.
Edits and attachments keep existing labels and uploaded media; an ambiguous
Evidence heading is refused rather than replaced.

## When Linear is unavailable

When Linear is not connected, the same tools select durable local storage.
Read `clankie doctor` for the active backend and reason; local records do not
automatically migrate when Linear is connected. A failed connected Linear call
stays a failure and never writes locally. GitHub connection failures still name
the recorded convention with `backend_unavailable`; report them to your lead.
Do not create another queue to compensate for an uncertain write. Explicit
export/import identity mapping is designed in ADR 0226; migration is not yet
implemented.
