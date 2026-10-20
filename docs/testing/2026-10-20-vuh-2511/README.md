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

The fix landed as `eb4682f55af7863582dff4da3d537f056a08feef` through integration
batch `9d4415fc-9df3-4418-9036-9c61f322d37d`. Worker and integrator landing gates
each passed 290 files / 2,116 tests (3 files / 9 tests skipped). The owner deployed
runtime `115569759`, which contains the fix, and confirmed health at
`2026-10-20T08:23:59Z`. The worker did not restart or deploy the runtime.

Supported live CLI reads independently confirmed:

- All three original event IDs have durable `rerouted` resolutions to
  `global-default`, with no pending source IDs.
- Wake `seat-719abc60-d4c7-47ef-987d-8a6ce1e31869` contains all three events,
  the KH2 project UUID and `project_fallback` route. It was offered at
  `08:23:48.450Z` and confirmed consumed at `08:24:07.514Z`.
- The source is `KH2 lead (inactive)`, `sessionState: unbound`. Its cursor is
  still `000000010014`; all 481 retained history events are identical to the
  baseline (canonical event-list SHA256
  `6b6e147c49c53dba98af8c557ef8fbf7ed61b5781781e69e5bf4710ce283c519`).
- The `08:28Z` retained lead transcript capture contains one missing-receiver
  notice and one destination copy of each event. The outage timestamp remains
  unchanged at the final read.

The comment links end in `d2226151`, `2404431e` and `6c0c4d37`. The lead reports
they were already answered on October 18 through another route. Recovery
correctly delivered the retained queue but redelivered already-handled work.
Earlier answers through the other route were not semantically deduplicated.

Two real post-deploy KH2 Auto rounds reached `global-default`:

- `8175f9c8-81c2-4385-ab0f-7d30074530d1`, delivered `08:42:08.979Z`.
- `b85e3c1a-ad8a-4375-83d9-39381ee052cb`, delivered `09:12:10.061Z`.

At the final read, `2026-10-20T09:13:05.297Z`, the source still had zero new
events or failed turns, no pending Linear IDs, the inactive title and the
identical 481-event history. This closes the requested two-round live window,
approximately 49 minutes after the reported healthy deployment. Raw snapshots,
the consumed receipt and the final summary are in the evidence manifest.
