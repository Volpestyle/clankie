# ADR 0279: Fleet counts come from the host roster

Status: Accepted, 2026-10-17. Tracks [VUH-2448](https://linear.app/vuhlp/issue/VUH-2448).

The owner needs to see how many agents are still working across machines and
which finished agents can be retired. App captions, animated poses and cached
message lists cannot establish that count or permission to close a pane.

The host projects its existing native fleet roster through owner-only
`GET /v1/fleet/roster`. The response includes one timestamp, complete/incomplete
source evidence, every observed agent, and counts by status, machine and lead.
Native working/waiting/idle/done maps to working/waiting/idle/finished; unsupported
statuses stay unknown. A pending host owner question takes precedence as waiting.
The client renders these facts without reconstructing them.

An idle or finished exact occupant becomes stale after more than one continuous
hour, with no queued messages, unacknowledged reports, running native children or
owner question pending. The host reuses its existing efficiency observation when
available and persists the observed inactive interval; a replacement
occupant starts a new interval. Missing historical status timing starts at the
first observation, never a guessed age. Incomplete source reads retain history
and name the gap; they cannot authorize retirement.

`POST /v1/fleet/roster/retire` takes only the seat and native occupant IDs. It
refreshes the host roster and resolves the existing hire's lead internally. The
owner's intent is attributed to that lead for the existing `PaneTidy.close`
implementation used by `close_worker_pane`. Kept reports, native drafts,
owner-started panes, process identity and dirty/unlanded work retain their guards.
A change to waiting or working, new pending work, changed owner or occupant, or
lost owner authority refuses before the native effect. The app route has no
force, report-path or unlanded-reason override.

A closed result supplies the existing history ID and five-minute undo deadline.
`POST /v1/fleet/roster/undo` resolves the original attribution privately and
calls `PaneTidy.undo`. A transport loss is uncertain: no client retries a mutation
automatically. Refusals are settled results with their reason; the pane remains.
Retirement does not decide or change tracker completion.

Only the operator or an owner-paired Take Control device may use these routes.
Hosted visitor, support, ordinary worker and social/captain credentials are
excluded. The relay, encrypted gateway route catalog, API client and
`clankie fleet roster [retire SEAT OCCUPANT | undo HISTORY_ID]` use this same
contract. The app adds one shared-shell view after VUH-2443.
