# Owner questions across native seat takeover (VUH-1881)

The service keeps unanswered asks pending in their original conversation when a
native seat attaches or polls. The owner can answer/cancel the same immutable
request; takeover neither selects an option nor grants approval. This is the
service half of [VUH-1881](https://linear.app/vuhlp/issue/VUH-1881); app rendering
follows separately.

## Cause and change

Both `rememberNativeSource` and `pollSeatEvents` explicitly called cancellation
with `native_seat_takeover`. Workspace preference validation also treated a
native driver as lost context, so removing only those two calls was insufficient.
Attachment now preserves questions; existing answers still require current owner
and original workspace identity. Creation of new workspace questions and project
confirmation retain their native-driver guards. A pending project proposal can
remain visible without authorizing a configuration write.

Question records expose optional `resolvedBy`
(`operator`, `device`, or `service`, with the actual ID), `resolvedAt`, and
`reason`. Explicit owner cancellation records the authenticated caller;
automatic cancellation records service `clankie`. Answers expose their stored
responder, including legacy submitted records. Old cancellations with no stored
actor stay unknown. Public reads do not invent a human answer or attribution. Resolution events
retain their frozen legacy shape; clients refresh the immutable question ID
for full attribution.

## Verification

All 100 focused checks passed (zero failures/skips), in 22.2 seconds under
`clankie heavy`. Protocol, service and TUI typechecks passed, along with focused
lint/format and documentation checks (574 Markdown files). [Case results](checks.json)
retain the tested base and durations. Rebase verification is recorded on the issue. Fixtures use temporary disk-backed conversation stores, public protocol
validation, real HTTP dispatch/authentication and the actual captain seat-poll
path. Model/native census seams in existing captain tests are fixtures; this is
not a live seat takeover or a device app rendering check.

The cases cover owner-action attachment/restart, native polling with a pending
ask, workspace preference remaining pending after attachment, refusal of project writes,
HTTP cancellation attribution, automatic cancellation attribution, original
answer attribution, and old cancelled records remaining cancelled.

The first focused run passed 42 cases and failed two: a frozen legacy event
parser rejected added fields (the event shape is now preserved), and an existing
case expected takeover cancellation (it now checks that the pending question
refuses a competing service continuation). These are retained in the local
check log; final results supersede them. A subsequent 97-pass/one-failure run
used a pending-only read after submission in the intermediate updated fixture.
Source review then retained the native-driver continuation fence explicitly:
workspace preference answers refuse and remain pending while a native driver
owns the conversation. Semantic owner-action asks retain ordinary answer/cancel
delivery.

## Scope and remaining gaps

No deploy, active seat takeover, owner settings write, or manipulation of the
historical `a935002b-ee57-44a5-b06f-d3925fbf049e` question. Historical cancellation
is retained; re-asking that owner action is the lead's choice. The app must
consume the updated shared protocol and render `cancelled` as cancelled; source
checks do not establish app presentation. No sudo or root diagnostics run.
