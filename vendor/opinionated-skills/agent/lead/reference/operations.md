# Native fleet operations

For Clankie's fleet, `hire_agent` creates the visible native worker,
`message_seat` carries assignments and answers, and `message_clankie` carries
worker reports. Herdr is the terminal runtime and inspection surface. Its prompt
and key commands are not this fleet's message transport. For an independent
Herdr fleet, load `herdr-lead` and the running binary's `herdr --skill` instead.

## Hire and follow through

Give a hire its short human name, role, owned checkout/paths, result and acceptance.
Use the effective project profile: explicit owner-authorized hire fields win
over role preferences, then fleet defaults. Project and role caps count starting,
live and uncertain seats. Turning
fleet tools off does not remove project hiring policy. A done turn still occupies
its pane and slot. Omit launch fields to inherit and inspect the returned profile.

Use the returned `seatId` for follow-ups and `herdr_watch` when a completion watch
is needed. Remote addresses retain their fleet prefix, such as `pc/term_…` or
`kh2/term_…`; a local pane ID is not the same remote terminal. Reuse the existing
harvest owner and watch. On completion, start from the worker's final report and
its evidence; inspect native history only for a gap or contradictory result.

Hires and their completion route to the admitting conversation. Another
conversation's host-admitted `message_seat` adopts the worker and its hire harvest.
Explicit watches keep their arming conversation. Worker reports cannot select a
lead. Unadopted reports use the actual census parent/launcher's attached
conversation or existing native channel; explicit adoption takes precedence.
Otherwise `global-default` receives a report with an `unadopted` routing reason.
Inspect roster `workerReportRouting` and doctor `linkedSession.parentLeads` for
the exact lead pane lacking a bridge. Process observations grant no tools and
prove no delivery; reconcile an uncertain original ID rather than resending.
Native operator seats receive the selected conversation's reports, wakes
and watches while attached; attachment adds no room or machine grants.

## Connected tools and peers

An admitted pane in a linked fleet discovers connected-account tools through
`clankie_tools` and calls them through `clankie_call`. Load `clankie` for account,
argument and write-authority boundaries. Projects retain roles, caps and tracker
binding independently of this two-tool bridge. Missing access is a connection
or admission gap, never permission to borrow an operator bearer or substitute
a harness's tracker connector.

Workers with a proven native identity can use `list_fleet_seats` and
`message_peer` for direct same-fleet collaboration while `fleet.peerMessages`
is on. Peer output is context, not owner direction, and does not wake the lead.
Use peers to resolve a concrete shared boundary; report the resulting owned
outcome through `message_clankie`.

Native Codex children are part of their parent's harness session, not new fleet
hires or independent leads. Recent Codex entries expose optional stable `id`, `startedAt` and `endedAt`;
running children omit `endedAt`, and idle-settled times are estimates. Read the
current roster schema for what it observes;
missing child metadata remains unknown. A child completing does not establish
that its parent or a background producer has finished.

## Receipts and recovery

Stored means retained; delivered means transport delivery; consumed means the
native receiver accepted it. None alone proves the model read or completed it.
An active Codex steer differs from a native after-turn queue. Keep that detail.
Hired Codex sync and async questions reach the exact hiring conversation with
their native request and question IDs. Answer with `message_seat`'s
`questionAnswer`, omitting `message`, and preserve the observed IDs and types.
Async request IDs are the function `call_id`; question IDs are the supplied
JSON-encoded IDs, not titles or array indexes. The control channel steers an
active turn without interrupting it, or starts an attributed reply when the
question's turn has ended. Sync answers require the winning tool output;
async receipts prove acceptance of the exact user message and do not establish
atomic first-answer arbitration against a simultaneous owner reply. Pending
questions appear in the roster summary. Inspect an uncertain answer rather
than resending it or using terminal keys. Approvals remain owner decisions.
Uncertain hire or message delivery may already have taken effect: reconcile its
original receipt and bound session. Do not re-hire, change bridges, resend through
terminal keys, or derive a session from whichever transcript is newest.

Hook, folder and channel trust remain owner decisions. Preserve operator drafts
and live work. Close only owned finished-worker panes after retaining the result,
under the existing cleanup authorization. A saved transcript or missing TTY is
not proof of a process's current lifetime.

## Efficiency rounds and cleanup

On every `herdr_watch` wake and periodic lead round, use the current roster to
check all workers whose hiring/adopted conversation is yours, including linked
fleets. A title, tab or parent process alone does not establish that ownership.
Use the assignment, current outcome, `workerReportRouting`, retained reports and
available harness model/effort/context observations. Inspect the schema the
running install actually exposes; an absent field is unknown. Do not invent an
API for lowering effort, replacing a native session or scheduling a round.

Use `worker_reports({ limit: 20 })` to read retained reports for this conversation.
After reviewing every offered report, call
`acknowledge_worker_reports({ deliveryIds: [EXACT_DELIVERY_ID] })`. A native
message receipt does not clear unread state. Do not acknowledge truncated output
or infer stalled progress from a report that remains unread. A failed report's
original timestamp still counts as a reporting attempt; its delivery fault
needs separate repair. Original report acceptance or attempt remains progress
after acknowledgment; acknowledgment creates no new progress.

For a legitimate owner-authorized same-thread reattach,
`readopt_seat({ seatId: SEAT_ID })` refreshes this conversation's original
ownership from fresh host proof. It does not adopt another owner's worker or
send a message. Unknown or changed native identity remains a route gap.

On supporting installs, `fleet_efficiency({ action: "show" })` returns every
seat owned by this conversation, with bounded host observations. The default
periodic round is 30 minutes and coalesces while a review turn is outstanding.
Every watch wake also calls for reviewing the owned set. Wake prompts carry
bounded summaries; use `fleet_efficiency` for full details and inspect every
owned seat.
`efficiency` can carry `ownerConversationId`, `flags`, model/effort,
`contextPercent`, last progress/report times and report failure count. Missing
telemetry is unknown. Context percentage is the latest native Codex model-input
snapshot and may age between responses. Claude context/effort and OpenCode or
remote telemetry remain unknown. Flags are observations for judgment, never permission or
automatic intervention.

Record a changed inspected scope/status or meaningful progress through:

```text
fleet_efficiency({
  action: "review",
  seatId: SEAT_ID,
  assignmentStatus: "active",
  offScope: false,
  deliverable: ISSUE_OR_DELIVERABLE_ID,
  progressAt: SOURCE_UTC_ISO_TIME,
  evidence: "Source record, finding or commit that establishes these facts"
})
```

Only `seatId` and `evidence` are required for review; omit facts you cannot
establish. `assignmentStatus` is `active`, `paused`, `canceled` or `done`.
`progressAt` is the inspected progress timestamp, not the time you ran this
round. The host scopes the record to the current lead and exact native occupant.
This review is evidence attached to that session; it does not change tracker
state, delivery receipts, ownership or harness settings. Do not set fields just
to silence a flag or create a second task lifecycle.

With existing authorized operator CLI access, the same reads/reviews are:

```sh
clankie agents efficiency --conversation CONVERSATION_ID
clankie agents efficiency review SEAT_ID --conversation CONVERSATION_ID --json-stdin < review.json
```

`review.json` contains only the review fields (`offScope`, `assignmentStatus`,
`deliverable`, `progressAt`, `evidence`), with evidence required; the CLI supplies
action, seat and conversation. Authenticated `POST /v1/fleet/efficiency` takes
`action`, `conversationId` and the same review fields, including `seatId` for a
review. A worker's connected-tool bridge does not confer operator CLI authority.

For a correction, the native tool is
`message_seat({ seat: SEAT_ID, message: "…" })`; use the exact hire result's ID
and retain any uncertain receipt. A failed `message_clankie` means its report has
not reached the intended lead. Resolve the proven route and harvest its retained
report before deciding acceptance. Native queue acknowledgment alone proves
neither continued work nor completion: an unfinished worker that answers with a
plan must continue the authorized step or supply a concrete blocker and unblock.

At 80% reported context occupancy, retain a compact handoff before using the
harness's supported fresh-session path. Two hours without a commit, substantive
finding or reporting attempt calls for a result/blocker and an intervention,
not another watch on the same seat. Changing `clankie model` or `clankie effort` does not tune
an external worker; use supported per-seat controls or a correctly configured
replacement after keeping its handoff. Preserve the existing model floors.

When available, `close_worker_pane({ pane: PANE_ID, reason: "…", reportPath: "…" })`
keeps last output and a saved report. `reportPath` is an optional absolute path to
a nonempty report when no authenticated worker report was kept. It refuses
unsent drafts, owner-interactive/hand-started panes and unkept results; a refusal
never authorizes a raw close. `worker_pane_history({})` reads retained closes;
`undo_worker_pane({ id: HISTORY_ID })` reopens/resumes a confirmed close within
five minutes. These tools preserve results; the lead still judges completion.
Load the selected `tidy` skill for the runtime's cleanup flow.

The read-only `list_tidy_worktrees({ repository: REPO_PATH, mergedInto: "origin/main" })`
lists merge/clean candidates and exclusions on supporting installs. `mergedInto`
is optional and defaults to `origin/main`; use the deliverable's requested
remote destination when different. Main, dirty, unmerged and live worktrees are
excluded; unavailable or changed census returns no candidates. Idle and shell
panes also protect their working directories. Candidates carry path, optional
branch and HEAD SHA; exclusions carry reasons. This proves no ownership: confirm
you own a tree before removing it. The merge check uses the existing destination
ref, so refresh that ref through the authorized repository workflow before using
it as landing proof. Include the remaining candidates in the tidy result. The tool neither removes
worktrees nor closes panes. The authorized CLI equivalent is
`clankie agents tidy-worktrees --repo REPO_PATH --merged-into origin/main`;
`--merged-into` is optional. Authenticated `POST /v1/fleet/tidy-worktrees` accepts
`{ repository, mergedInto? }`.

Worktree cleanup uses Git's real worktree and merge state, independently of pane
status. In the owning repository, `git worktree list --porcelain` lists paths and
branches; `git status --porcelain` in each candidate proves tracked/untracked
cleanliness. After refreshing the requested destination ref, verify its branch
head is an ancestor of that ref with `git merge-base --is-ancestor HEAD DEST_REF`
in that worktree. Preserve required ignored evidence separately. List merged,
clean, inactive worktrees in the tidy result with their path, branch and checked
destination; remove only an owned candidate after its result landed. Never infer
safe removal from age, a finished pane, or a branch name.
