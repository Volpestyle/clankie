# LOCAL-VUH-13: uncertain READ receipt inspection and abandonment

Issue: LOCAL-VUH-13 (built-in tracker issue `c42c28a2-c37d-4b37-8ff8-083f172a5ffa`)
(blocks VUH-2028). This supersedes the uncommitted 2026-10-13 candidate, which
stopped because no genuine native caller could reach a disposable host. The CLI
and API contract is in [docs/cli.md](../../cli.md).

## Contract

`clankie_call({receiptId, action: "inspect", abandonmentId?})` and
`clankie_call({receiptId, action: "abandon-read", reason})`, natively
`clankie agents call-receipt inspect|abandon-read`.

- **Classification is host-owned and pre-effect.** Under its store lock, after
  synchronous host checks and before the read runs, the built-in tracker emits a
  `builtin-strict-no-effect/v1` snapshot binding the store directory incarnation
  and store ID. It does so only for `get_issue`, `get_user` and `list_runs`
  without a host runner, on an initialized store with no cycle due and the
  default clock. The host adds the account binding, argument fingerprint and
  selectors (at most 1 KiB). The worker receipt keeps that with the original
  native session from `admittedProjectProof`. Names, caller fields, age and
  errors never classify. Every receipt made before this change is UNKNOWN.
- **Inspect** reports, for any retained receipt, `classification`, `recovery`
  (`abandonable`, and the reason when not), the original, the execution and the
  abandonment as separate facts. An abandonable READ is first rechecked against
  current access, the tools setting, the account and route, the same native
  session, and the original store incarnation under its lock. Inspect never
  dispatches the original.
- **Abandon** additionally needs a bridge-minted `abandonmentId`. It appends one
  audit (ID, reason, actor, native session, request and snapshot fingerprints).
  The same ID answers the same audit; a different decision is refused with
  `abandonment_conflict`. It is not a claim of cancellation, nonexecution or
  success. A late original result settles in place and keeps the audit. Unproven
  originals are refused with `original_read_unproven` and record nothing.
- **A definite read error stays definite.** A backend throw after the snapshot
  (for example "Issue not found") settles the receipt as `confirmed-error`.

The service's own tracker has a host runner, so in production only `get_issue`
and `get_user` can qualify. Repository-routed calls and remote providers stay
UNKNOWN. LOCAL-VUH-34's repository-routed Linear case is a separate dispatched
path and is not changed here.

## Store lock and journal

Host fences, routing and the native census (bounded at 1 s) run before the store
lock, for reads and for recovery alike. Under the lock only synchronous checks
and the durable admission run. That admission is a receipt journal rewrite that
must precede the read: it is what lets a read lost mid-flight be abandoned
later. Built-in writes already rewrite the journal under the same lock at
dispatch.

A measurement host was seeded with 12,261 receipts (5.0 MB, 1,000 retained
bodies), shaped like the live journal's 12,261 records (7.2 MB). Over 20
alternating rounds through the stock bridge, an eligible `get_issue` held the
store lock for a median of 26.0 ms (p90 27.8, max 33.3). An ineligible
`list_issues` held it for 0.5 ms (max 1.7). End to end, `get_issue` took a median
of 840 ms against 509 ms for `list_issues`; the difference is the out-of-lock
census and fences. Live-size lock hold was not measured.

A READ proof adds about 1.1 KB to a receipt. When a settled body leaves the
newest 1,000, its READ proof is dropped too (`proofRetention: "trimmed"`), unless
it holds an abandonment audit. Uncertain receipts keep theirs.

## Production-path proof (2026-10-19)

`apps/clankie/scripts/read-receipt-proof-host.ts` composes the production
`LocalFleetLink` with `localFleetAdmissionProof`/`localProjectProof` (kernel
socket census and the live Herdr pane, bound as the installed service binds it:
`external` runtime, session `default`), plus `WorkerMcp`, `createMcpHost`, an
empty `FileCredentialStore`, `SettingsStore` and the built-in tracker. All of it
lives under one new private root on a loopback port, run through
`clankie heavy --server`. Its discovery link is written only under that root. The
installed links, registry, credentials and service were not touched.

`apps/clankie/scripts/read-receipt-proof-driver.ts` ran from native Claude seat
`w5J:p5`, so its children carry that pane's real ancestry. The originals went
through the stock `fleet-mcp.mjs` stdio bridge (`CLANKIE_STATE` pointing at the
root). Recovery went through both that bridge and the source CLI. Results are in
[evidence.json](evidence.json):

| Case                                                          | Outcome                                                                                         |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `get_issue`, `get_user`, `list_runs` originals                | `inspected`, READ, abandonable, `dispatchAdmission: recorded`, `confirmed-success`              |
| `get_issue` with a mistyped key                               | definite `isError` reply; inspect READ, `confirmed-error`                                       |
| `abandon-read` via CLI and via the stock bridge               | `abandoned-read`, audit recorded                                                                |
| A second, different abandonment                               | refused `abandonment_conflict`, earlier audit kept                                              |
| Ordinary `{receiptId}` lookup after abandonment               | the original result, unchanged                                                                  |
| `save_issue` original; `list_runs` on a runner-backed tracker | inspect UNKNOWN, `confirmed-success`, not abandonable; abandon refused `original_read_unproven` |
| Missing receipt                                               | inspect uncertain UNKNOWN; nothing recorded                                                     |
| Caller-supplied `classification: "READ"`                      | refused by the strict schema                                                                    |
| Spoofed pane header                                           | native admission refused (`pane_unavailable`); the bridge reports its usual uncertain lookup    |
| Fleet tools off                                               | refused; inspect works again once tools are restored                                            |
| The root's own store replaced by a new incarnation            | inspect and abandon refused                                                                     |

The hosts closed, removed their private links and left no processes.

## Integration tests

`apps/clankie/test/worker-call-receipts.integration.test.ts` drives the real
WorkerMcp, McpHost and built-in tracker over HTTP. Its identity and native
session are synthetic, so it proves WorkerMcp behaviour, not native admission.
On READ-classified receipts it covers:

- positive inspect;
- abandonment, an identical retry and a conflicting decision;
- a mistyped key settling as `confirmed-error`;
- a lost reply that stays uncertain, is abandoned, and then receives its late
  result with the audit intact;
- another native session on the same pane being refused;
- a route change and a revoked admission during recovery, refusing without an
  audit.

It also keeps the missing, unproven and caller-assertion cases. The backend
cases (initialization, runner, custom clock, rollover, store replacement) use
the real locked tracker.

## Not proven natively

- Abandoning a genuinely uncertain READ, and its late result. Every native
  original settled; only the integration test's lost reply exercises this.
- Refusal for a different native session on the same pane or another live pane.
  That needs a second genuine seat; the integration test uses a synthetic one.
- Account, grant or route change while a receipt is held. The integration test
  covers route and revoked admission; account change has no built-in tracker
  analogue to drive.
- Lock hold against the live 7.2 MB journal, and the full service process or an
  installed release. The proof host composes production modules, not
  `apps/clankie/src/index.ts`.

## Legacy originals

`70136c4f-43ad-45f3-8434-5de9fd04545a` (`get_issue`) and
`7065c6aa-fffb-4e55-9c0f-550d139af96c` (`list_runs`) were written before any
receipt retained classification or a native session. No host record can prove
them READ, so they **stay blocked and UNKNOWN permanently**. The second would
stay UNKNOWN even under this contract, because the service tracker's `list_runs`
calls the host runner. Neither was looked up, polled, settled, abandoned or
replayed. VUH-2028 proceeds with new calls under new receipts.
