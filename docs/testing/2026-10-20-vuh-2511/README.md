# VUH-2511 — recover Linear activity from a dead lead

Tracks: [VUH-2511](https://linear.app/vuhlp/issue/VUH-2511).

## Finding

Supported CLI reads on 2026-10-20 found 27 retained offers of the same three
KH2 events to `conv-7687818a-09c3-4f37-bf7b-9d201c2e1932`, despite its removed
project route. The five-page retained conversation has 39 failed turns in total;
the latest missing-receiver failure is `2026-10-20T06:22:45.616Z`, cursor
`000000010014`. These totals cover retained history, not the conversation's lifetime.

Startup queued every unread backlog without consulting current routes. The
native runner threw on the remembered disconnected receiver and rewound the
offered cursor, allowing the same activity to fail again after restart.

## Change and proof

Before admission, resolve retained events against current project/default
routes; unavailable receivers fall back to `global-default`. Destination-first
copies and source resolutions retain the original event IDs and notification
identity. The deliveries API/CLI exposes `recoveries`, including pending IDs
and `rerouted`/`already_handled` results. Uncertain native takes stay pinned.

Missing receivers get one durable default-lead notice. Admission retries are
one preflight per burst/restart or a proven native poll, with no retry timer.
Unavailable nondefault chats show `(inactive)` and preserve history. Pending
activity and missing-receiver histories are protected from automatic pruning.

The retained check logs exercise signed HTTP ingress, persisted settings and
conversation journals, the production runner/driver fence, native mailbox,
authenticated recovery inspection and original-receipt confirmation. Recovery
tests cover route removal, an unavailable configured route, destination-first
crash recovery, old-history retention, three restart rounds without failed
turns, and a receiver returning after quiet holds. Existing receipt tests cover
wrong-recipient refusals and uncertain/late native ACKs.

`focused-latest.log`: 21 passing tests (native delivery/recovery and conversation
driver). The unchanged routing and notification-receipt checks also passed in
`focused-final.log`; that earlier run exposed a driver test's missing configured
target, corrected and verified in the latest run. Initial failures are retained
and labelled by their original filenames. No evals ran.

The landing report/log records the root `pnpm check:landing` result separately;
the Linear result comment names the submitted revision and integration receipt.
Raw captures and logs are in the adjacent evidence-store manifest.

## Deployment and live verification

This is predeployment evidence. The worker did not restart or deploy the runtime.
After owner deployment, verify the same dead conversation has no new failed
turns over a couple of Auto rounds, account for all three retained event IDs in
`recoveries`, and retain a KH2 event's consumed receipt in `global-default`.
Those live checks remain open until recorded on VUH-2511.
