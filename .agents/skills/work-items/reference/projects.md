# Projects and seats

Project-level tracker reads and settings for [work-items](../SKILL.md), on every
backend.

## Project facts

`clankie work project` reads planned milestones, shipped versions and Linear
initiative goals through the saved tracker. The device op is `work_project`;
its repo id has the same registered/project binding as `work_items`.
`/work project` opens the same read in the TUI. To select release facts, use
`clankie work init --release-source tags|milestones|both --release-lane NAME`;
this preserves an existing tracker. Both is the default, and `repository` is
an explicit unspecified-platform lane until the owner names `macos`, `mobile`,
or another lane. Separate repos carry separate lanes.

Backlog stays distinct from todo: Linear backlog/triage, GitHub's explicit
`status: backlog` label, and Markdown `status: backlog`. Device item reads
opt in with `statusVersion: 2`; older reads project backlog to todo. Items may
state `milestone: {id, name}`; Markdown supplies both `milestone_id` and
`milestone_name`. Priority is the native optional 0–4 projection.

Read the `unavailable` entries before describing releases or goals. A completed
milestone is not shipment; version-tag dates state their `dateKind`. Local tags
are read without a fetch. GitHub published releases take precedence for the same
tag. Store builds and release item membership remain unstated unless the source
supplies them. GitHub/Markdown have no initiative goals; Markdown has no planned
milestone collection. Device renders use the shared host snapshots, never a
separate provider poller.

## Project settings and narrow writes

`clankie project settings PROJECT --auto-updates on|off` sets evidence-first
progress reports (default on), through the revision-fenced project settings API's
`autoUpdates`. Off preserves the project's existing owner-loop cadence; silent
still suppresses posts. Auto reuses measured outcomes and bounded media hints to
request one update after noteworthy progress accumulates, roughly daily unless a
new milestone lands. Read the previous update and changed issues when asked;
lead with issue clips and stills at stable asset URLs and short captions, then
what is open and what comes next. A hint is not proof of delivery or publication
authority. Reconcile uncertain status-update writes before doing anything else.

`clankie project settings PROJECT --reviewer-role ROLE|--reviewer-seat SEAT|--reviewer none`
names the project's standing landing reviewer
([ADR 0287](../../../../docs/adr/0287-a-standing-reviewer-gates-every-landing.md)).
While one is set, `pnpm check:landing` exits 3 until the reviewer approves the
exact patch. Prefer a role, because seats retire. `clankie review list|show`
reads the candidates and verdicts; they are part of the project's review record,
and an issue still gets its own verdict comment.

For an existing project's team settings, `clankie project list` returns the
current revision. `clankie project update PROJECT --changes FILE.json --revision
REVISION` changes only the reviewed name, roles, worker cap or tracker binding;
`/project` exposes the same commands in the console. Follow explicit task or
owner authorization before changing those settings. A tracker binding points
to an already enrolled workspace's existing `.clankie/tracking.json`; it does
not initialize tracking or choose a connected account. The app reads local
bindings through project repo references. Remote or missing sources
remain unavailable, never a reason to select another local repo or backend.

Owner-authorized devices with `terminalControl` can set work metadata owner,
add/remove a role label, or append a prerequisite using `work_item_write`.
`clankie work write ID --owner NAME|--no-owner|--add-label ROLE|--remove-label
ROLE|--add-blocker ID` uses the same narrow receipt path. It returns a
`requestId` and `applied`, `refused`, or `uncertain`. Keep the ID; use
`clankie work receipt ID --request-id UUID` or `work_item_write_receipt` after
uncertainty. Never resend the change with a new ID. This path requires a saved
local tracker and connected provider account; it preserves unrelated labels
and prerequisites. Broader agent updates retain the existing CLI and tools.
Items may have an optional backend-native `parent`; it groups work and does
not imply a prerequisite.

During conversational project onboarding, a missing convention can be included
in `propose_project_create` as `trackerSetup`; `this-machine`'s work reference
covers that flow. An existing convention must be read and reused;
initialization refuses to replace it.

## Seat retirement bookkeeping

Retirement and automatic exit bookkeeping retain the full issue key and its
resolved UUID. They use the confirmed native hire's **current saved project
tracker**, never a suffix from `LOCAL-*`, the lead's cwd, or an implicit default
connector. Key and UUID assignments refer to the same item only within that
tracker scope. Missing, revoked, ambiguous or changed attribution refuses the
issue effect even if the pane itself closed successfully; inspect the returned
`issue` settlement. A saved Linear scope needs its original connected account;
disconnection does not select a local compatibility store.

Local workspaces sharing a saved Linear team, project and label share the
retirement scope even when their convention provenance or docs differ. Each
saved file is still revalidated before issue effects.

Built-in retirement cannot set Done or impersonate owner verification, and it
cannot move delivery backwards. Existing evidence, independent-check and owner
verification gates still apply. Report the actual refusal and leave the lead to
settle the item's delivery state. Historical pause entries without a verified
scope do not authorize restoration. Daily ownership checks include verified hire
scopes; unscoped operator-head/native-child claims are not counted until their
tracker can be attributed, and do not authorize automatic issue writes.

## Giving a free hand work from World

World holds an original drop for four seconds with Undo before any write. Busy
agents remain play only when picked up themselves. A real free-agent drop requires confirmed idle, no assignment or
active goal and observed zero running children; an unknown count is not zero.
The optional `freeAgent` field on existing role, conversation and owner work
writes binds persona, native seat/occupant and project. CLI equivalents append
`--free-agent JSON` to `agents role`, `send` or `work assign`. It is a restriction,
never authority; the host refreshes addressed native child and membership proof
at its existing effect fences. Ordinary commands without it retain their behavior.

Work assignment and the original “Please pick up…” note have separate receipts.
Report an applied assignment with an uncertain note plainly; never reverse or
replay either effect. A teammate drop uses the exact conversation's `co-w`
quick-action catalog entry and actual native pane ID in the same project/session.
Display names are tracker data, never native addresses. A ground drop is local
idle play toward the campfire and writes no machine position.

## Handing a work piece to a current worker

Picking up the work itself is an explicit owner handoff and may address a busy
current non-lead worker. The app holds the original item and recipient for four
seconds with Undo; empty ground returns the visual object without effects.
Hand to and VoiceOver use that same original intent. API `workHandoff` and CLI
`--work-handoff JSON` on `work write ID --owner NAME` / `send` bind exact persona, native seat,
occupant and confirmed project. Never combine it with `freeAgent`, infer a
recipient from its name, or strip it after refusal. Missing Take Control, tracker
scope, native recipient or original thread refuses before the owner write. The
assignment and original note retain separate receipts; uncertainty is checked,
never replayed or reversed.

Project update threads use the existing comment tools: `list_comments` with `statusUpdateId` and `statusUpdateType: "project"`, and `save_comment` with `statusUpdateId` and `body`. A reply to a reply uses `parentId`. Do not post an update reply with `projectId`: that creates a project-level comment. `work project-details` includes up to 200 `replies` in time order on the latest 20 updates. `replyCount` is a lower bound when `repliesTruncated` is true. Failed thread reads and older updates omit reply fields.
