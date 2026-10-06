# VUH-1704 defensive OS and proof-alert settlement

On 2026-10-06 the explicit owned-native run passed both defensive OS cases.
[Actual counter snapshots](native.json) contain no PIDs, paths or argv. The
unchanged production native helper produced these four previously unmet reasons:

| Fixed reason | Actual producer | Counter |
| --- | --- | ---: |
| `ancestry_bounds` | Real 65-parent ancestry; only the leaf opens the TCP socket | 1 |
| `process_census_unavailable` | Owned helper sandbox denies OS process-list inspection | 1 |
| `fd_list_unavailable` | Owned helper sandbox denies OS FD inspection on a real TCP connection | 1 |
| `argv_unavailable` | Owned helper sandbox denies its OS argv sysctl reads | 1 |

The ancestry test uses real Herdr, TCP, kernel processes and the production
socket proof. The sandbox tests run the unchanged installed helper on actual
TCP/process targets and feed its parsed diagnostics to the production collector.
Their deny policy applies only to that owned helper invocation; it changes no
host policy, peer process or proof implementation. All helper requests refuse.
These direct helper diagnostics do not independently assert the full
HTTP-to-Herdr admission path for each sandbox case.

## Alert settlement

A separate optional per-call observer distinguishes `accepted`, `unconfirmed`
and `unavailable`; the existing Captain boolean submission contract remains.
An unconfirmed proof alert keeps its original mailbox acknowledgment reader.
The collector never retries that held alert and does not start accepted-delivery
cooldown. Only a matching original receipt/binding starts the five-minute
cooldown. Exceptions or conflicting original evidence remain held. Native
mailbox IDs and bindings remain private. Stored next-turn mail is held rather
than accepted; its exact ID, binding and content acknowledgment is read without
rewriting or taking its journal. A prior identical receipt without a current
dispatch guard cannot acquire acceptance.

The real mailbox/filesystem regression takes an event without acknowledging it,
observes uncertainty, then continues proof observations for six configured
minutes with one dispatch. Invented IDs and wrong bindings refuse. The exact
original acknowledgment starts cooldown; another attempt becomes eligible only
after five further minutes. This is protocol-client evidence, not an original
owner TUI receipt. Existing eight real worker-receipt producer checks were
already integrated separately; no original POST is replayed here.

## Remaining acceptance

Twelve defensive OS producers remain unproved: `clock_unavailable`,
`allocation_failed`, `fd_list_bounds`, `fd_record_invalid`,
`socket_identity_invalid`, `process_changed`, `ancestry_unavailable`,
`ancestry_changed`, `ancestry_cycle`, `executable_unavailable`,
`executable_changed`, and `argv_changed`. Vocabulary-only samples do not count
as OS producer evidence. A bounded real exec-churn probe produced only the
already-covered `argv_unavailable`; it did not establish those race branches.

Actual threshold delivery into James's original native owner conversation and
the subsequent Linear check-in remain open with Kai/Ash and the lead. An HTTP
ACK or a peer message does not substitute for that acceptance. VUH-1743's source
repair depends on the original native poll resuming; this work did not restart
or repoint the owner lane. Keep VUH-1704 open.

Reproduce with both fleet heavy wrappers and the built production helper:

```sh
FLEET_DEFENSIVE_OS_TEST=1 pnpm exec vitest run \
  apps/clankie/test/fleet-defensive-os-native.integration.test.ts \
  apps/clankie/test/fleet-health-metrics.integration.test.ts
```

Raw owned evidence is under `.local/1704/{defensive-*,sandbox-*}`. The two-file
run passed five cases; the separate focused collector/refresh/tidy run passed
20 cases and all three affected package typechecks.
