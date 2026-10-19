# LOCAL-VUH-13: uncertain READ receipt inspection and abandonment

Issue: LOCAL-VUH-13 (built-in tracker issue `c42c28a2-c37d-4b37-8ff8-083f172a5ffa`)
(blocks VUH-2028). This supersedes the uncommitted 2026-10-13 candidate, which
stopped because no genuine native caller could reach a disposable host.

## Contract

`clankie_call({receiptId, action: "inspect", abandonmentId?})` and
`clankie_call({receiptId, action: "abandon-read", reason})`, natively
`clankie agents call-receipt inspect|abandon-read` ([CLI](../../cli.md)).

- **Classification is host-owned and pre-effect.** The built-in tracker emits a
  `builtin-strict-no-effect/v1` snapshot under its store lock, after a fresh host
  fence and before the read runs, only for `get_issue`, `get_user`, and
  `list_runs` without a host runner, on an initialized store with no cycle due
  and the default clock. The worker receipt stores it with the argument
  fingerprint, account binding, store directory incarnation and store ID, plus
  the original native session from `admittedProjectProof` (occupant, shell and
  harness process lifetimes). Names, caller fields, age and errors never
  classify. Everything else, including every receipt made before this change,
  is UNKNOWN.
- **Inspect** rechecks current access, tools setting, account binding, the same
  native session and the original store incarnation under its lock, then reports
  classification, original, execution and abandonment as separate facts. It
  never dispatches the original.
- **Abandon** needs all of the above plus a bridge-minted `abandonmentId`. It
  appends one audit (id, reason, actor, native session, request and snapshot
  fingerprints) to the receipt; an identical retry answers the same audit, and a
  different decision is refused. It is not a claim of cancellation,
  nonexecution or success. A late original result settles in place and keeps the
  audit. An unproven original is refused with `original_read_unproven` and
  nothing is recorded.

The service's own tracker has a host runner, so in production only `get_issue`
and `get_user` can qualify. Repository-routed calls and remote providers stay
UNKNOWN.

## Production-path proof (2026-10-19)

`apps/clankie/scripts/read-receipt-proof-host.ts` composes the production
`LocalFleetLink` with `localFleetAdmissionProof`/`localProjectProof` (kernel
socket census and the live Herdr pane), `WorkerMcp`, `createMcpHost`, an empty
`FileCredentialStore`, `SettingsStore` and the built-in tracker, all under one
new private root on a loopback port, run through `clankie heavy --server`. Its
discovery link is written only under that root. The installed links, registry,
credentials and service were not touched.

`apps/clankie/scripts/read-receipt-proof-driver.ts` ran from native Claude seat
`w5J:p5`, so its children carry that pane's real ancestry. The originals went
through the stock `fleet-mcp.mjs` stdio bridge (`CLANKIE_STATE` pointing at the
root), and recovery went through both that bridge and the source CLI. Results
are in [evidence.json](evidence.json):

| Case                                                          | Outcome                                                                                        |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `get_issue`, `get_user`, `list_runs` originals                | `inspected`, READ, `dispatchAdmission: recorded`, `confirmed-success`, retained native session |
| `abandon-read` via CLI and via the stock bridge               | `abandoned-read`, audit recorded                                                               |
| A second, different abandonment                               | refused, earlier audit kept                                                                    |
| Ordinary `{receiptId}` lookup after abandonment               | the original result, unchanged                                                                 |
| `save_issue` original; `list_runs` on a runner-backed tracker | inspect UNKNOWN; abandon refused `original_read_unproven`                                      |
| Missing receipt                                               | inspect UNKNOWN; nothing recorded                                                              |
| Caller-supplied `classification: "READ"`                      | refused by the strict schema                                                                   |
| Spoofed pane header                                           | native admission refused (`pane_unavailable`); the bridge reports its usual uncertain lookup   |
| Fleet tools off                                               | refused; inspect works again once tools are restored                                           |
| The root's own store replaced by a new incarnation            | inspect and abandon refused                                                                    |

Across both hosts there were 55 native admissions, bound as the installed
service binds this pane (`external` runtime, session `default`). The only
refusal was the spoofed pane. An earlier identical run also passed after two
first-attempt observation retries (`socket_unavailable`,
`process_census_changed`). The hosts closed, removed their private links and
left no processes.

## Not proven natively

- Refusal for a different native session on the same pane, or for another live
  pane. That needs a second genuine seat; only the synthetic-identity
  integration test covers it.
- Account change, revoked grant and repository-route change while a receipt is
  held. The integration tests and source fences cover these, not a native run.
- A late original result arriving after abandonment. The source settles it in
  place, but no native run timed this race.
- The full service process and an installed release. The proof host composes
  production modules, not `apps/clankie/src/index.ts`.

## Legacy originals

`70136c4f-43ad-45f3-8434-5de9fd04545a` (`get_issue`) and
`7065c6aa-fffb-4e55-9c0f-550d139af96c` (`list_runs`) were written before any
receipt retained classification or a native session. No host record can prove
them READ, so they **stay blocked and UNKNOWN permanently**. The second would
stay UNKNOWN even under this contract, because the service tracker's `list_runs`
calls the host runner. Neither was looked up, polled, settled, abandoned or
replayed. VUH-2028 proceeds with new calls under new receipts.
