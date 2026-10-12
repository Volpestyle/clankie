# VUH-2188: bounded exact-ID worker report read

Tracks: https://linear.app/vuhlp/issue/VUH-2188

Source commit: `6c4d499d3db80699f245164f918c55b364178e3d`, based on fetched
`origin/main` `9049755b2f722625500ac091c5c41d48177cce4f`.
Integration receipt and landed commit are recorded on the issue after submission.

## Result

`worker_reports` accepts optional `deliveryIds` (1–100 UUIDs), projected through
the shared operator API/client and `clankie agents reports --conversation ID
--delivery-ids ID,ID`. Without a selector, oldest-first ordering and the default
20-record limit remain. Targeted reads default to up to 100 selected unread
records, with an optional lower limit. All paths retain the 128 KiB complete-page
budget. Native/MCP returns the exact compact envelope instead of clipping an
already-offered page through the generic 50 KiB pretty-JSON preview.

Selection occurs after conversation scoping. Unknown, foreign and read IDs are
omitted without revealing which case occurred. Only complete returned items gain
`offeredAt`; reading leaves them unread. Acknowledgment remains explicit and
offered-only. No delivery policy, history cleanup or replay route changed.

## Verification

- Real service-boundary integration: 10/10 passed. A private 669-report persisted
  backlog permits newest-targeted read then explicit ack (668 remain); an
  unoffered sibling refuses. Foreign/unknown selection returns no private data
  and does not offer those records. Default oldest-first reads remain compatible.
  Empty, malformed and over-100-ID selectors fail before offering. Oversized
  pages return only complete records, and omitted siblings still refuse ack.
- Native/MCP behavior: 6/6 focused checks passed. Mixed acknowledgment retains
  every refusal reason. A targeted MCP page above 50 KiB and below 128 KiB parses
  completely with all five valid large payloads and exact acknowledgment IDs.
  Existing non-API captain authority refusals remain intact.
- Strict MCP client schemas: 32/32 passed across five existing schema suites.
- Affected CLI, operator client and protocol consumers: 72/72 passed.
- Protocol typecheck passed under the existing compiler heap budget.
- Explicit touched-file formatting/lint and repository doc-link checks passed.
- Independent native security/diff read: no remaining findings after compact
  native output corrected the inherited clipping boundary.

## Retained failures

The first native/MCP checks failed before tests started: this clean worktree had
no installed dependencies (`ERR_MODULE_NOT_FOUND: vitest`). A governed frozen
install completed and the original logs remain in the proof bundle.

The first 669-record fixture run exceeded the existing 30,000 ms deadline
(38,021 ms; 9 passed, 1 failed). The new large-backlog fixture seed was optimized
through real store inbound acceptance rather than repeatedly serializing the
sender's delivery fence; HTTP/CLI reads and acknowledgments remain real. The
retry passed 10/10 in 22.79 seconds overall (18.32 seconds of tests). Neither
product defaults nor deadlines were changed. Both original and retry logs remain.

## Gaps

This proves isolated real store/API/CLI and native/MCP boundaries, not a deployed
runtime. The fixture uses the established no-model report app route, temporary
storage, and an OS-assigned loopback port; it does not start the service/relay
entrypoints. No installed ports, live historical reports, credentials, owner
checkout or pinned runtime were modified. No deployment, restart or eval ran.
The assigned integrator supplies the authoritative exact-tree landing gate.
