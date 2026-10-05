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
