# Opaque Work ids route for worker seats (LOCAL-VUH-52)

`post_bundle_check(bundleId)` now reaches the cut-over built-in project that
owns the bundle's issue. Runs use the same ownership lookup. The existing
committed-array indexes cover bundles, runs, saved issue views, guided reviews
(including retired identity records), and cycles. Argument extraction adds
`bundleId`, `runId`, `parentRunId` and audit `entityId`. Existing ambiguity,
cross-project and publication fences remain in force. No role profile, budget,
public API, CLI setting, or checkpoint publication code changes.

## Built-in-only tool audit

All names below are the canonical tools behind `linear_*`. An indexed id is
routing metadata, never authority or a substitute for required schema fields.
An unknown reference does not select a project. Existing hire/explicit `repo`
routing still applies; a resulting Linear destination refuses built-in-only
operations before provider dispatch (`invalid_arguments`, `possiblyDispatched:
false`). A built-in destination can instead return its normal not-found refusal.
We deliberately retain this distinction rather than guessing an unknown id's owner.

| Tools / arguments                                                                                                    | Decision                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `post_bundle_check(bundleId)`                                                                                        | Index bundle → issue → project; accept only an independent authorized checker. Unknown id refuses without dispatch to Linear.                                                                               |
| `post_run_control(runId)`                                                                                            | Index run → issue → project; owner/lead role requirement unchanged.                                                                                                                                         |
| `save_run(id)` update, `save_run(parentRunId, issueId)` child creation                                               | Index run ids and extract `parentRunId`; existing issue/actor/parent checks remain. Creation still requires issue scope in the backend.                                                                     |
| `save_evidence_bundle`, `get_evidence_bundle`, `post_issue_ask`                                                      | Already carry required `issueId`; also extract optional `runId`. Conflicting known project references refuse.                                                                                               |
| `save_issue_view`, `get_issue_view`, `list_issue_view_issues`, `post_delete_issue_view`                              | Index view UUID; still require exact `project` and `storeId`. UUID alone must refuse schema validation. `list_issue_views` uses required project scope.                                                     |
| `save_guided_review`, `get_guided_review`, `post_guided_finding`, `post_retire_guided_review`, `list_guided_reviews` | Required `issueId` already routes; review UUIDs also indexed. Finding ids and expected-source identity do not select a project. Missing issue scope refuses. Retirement still needs proven owner authority. |
| `get_cycle(id)`                                                                                                      | Index cycle → project. Unknown id follows the same refusal policy.                                                                                                                                          |
| `list_audit_events(entityId)`                                                                                        | Extract `entityId` and resolve indexed records; without one, use existing hire/explicit repo routing.                                                                                                       |
| `get_write_receipt(idempotencyKey)`                                                                                  | Deliberately do not index actor-private, potentially reused receipt keys. Use hire/explicit repo; Linear destination refuses.                                                                               |
| `save_issue_status(id/name/type)`                                                                                    | Store/team-wide status has no unique project owner; deliberately use hire/explicit repo, otherwise refuse on Linear.                                                                                        |
| `list_issue_events`, `list_runs`, `list_ready_issues`, `list_drift`, `list_changes`                                  | Supplied issue/project reference routes normally; omitted scope deliberately uses hire/explicit repo, otherwise refuses on Linear. Cursors, `since` and `storeId` are not project references.               |
| `post_issue_event`, `save_lease`                                                                                     | Required issue reference already routes.                                                                                                                                                                    |
| `inbox_pending_questions`, `get_inbox_item`, `post_snooze_inbox_item`, `post_unsnooze_inbox_item`                    | Required project already routes; store/target ids never grant owner mailbox capability. Native MCP without that capability remains refused.                                                                 |

## Proof

The integration test starts a fresh `tsx` process with an allowlisted environment,
scratch HOME/XDG and explicit scratch tracker/settings/credential paths. It
reuses the unchanged LOCAL-VUH-46 production HTTP/MCP fixture. Real confirmed
hires in a **Linear-backed** project address bundles in a separate cut-over
built-in project, with no `repo` override. This ensures hire fallback cannot
hide the original bug. Linear is configured as a fixture connection whose
network endpoint is unused. The initial built-in convention represents the
post-cutover state; import/promotion is covered by the unchanged cutover suite.

Assertions cover reviewer attribution and matching `bundle_checked` event,
checking a newly appended bundle from a builder seat, self-check refusal,
unknown bundle refusal before provider dispatch, worker run-control role refusal,
lead run-control routing by `runId`, and own-run update by `id`. It then makes
the hire's own project built-in and proves a check on that project's bundle
plus an unknown bundle's normal `Bundle not found` refusal. The probe wraps
real `fs.promises.readFile` and observes **zero checkpoint rereads** throughout
these same-process writes and routing calls. Durable tracker/receipt writes,
default role profiles and real default request budgets are active.

Evidence bytes are uploaded to the real scratch evidence store. The reused
fixture's evidence validator is a no-op; this proof establishes routing and
authority behavior, not evidence admission validation. Its native-pane identity
adapter is synthetic and its captain is unused; no native harness is launched.
No live tracker, owner HOME, broker, Keychain, or real provider is opened.

The new test fails against original product files from `68df2c3d2` with the
exact reported built-in-only refusal and passes with the patch. Existing
`linear-cutover`, `tracker-role-budget` and `tracker-publication` suites run
unchanged beside it.

```sh
clankie heavy -- pnpm exec vitest run \
  apps/clankie/test/tracker-bundle-routing.integration.test.ts \
  apps/clankie/test/linear-cutover.integration.test.ts \
  apps/clankie/test/tracker-role-budget.integration.test.ts \
  packages/work-items/test/tracker-publication.integration.test.ts
```

Focused checks: **15/15 pass across four suites**. Work-items typecheck passes.
[Raw regression and passing logs, executed proof/fixture sources and product hashes](clankie://evidence/sha256/0e3300f4fec3a02b3dc3a325e097ae6189d9211467a7004dd57766ae1474dd9a) are published through the evidence manifest. Landing/review
results are recorded on LOCAL-VUH-52 after completion.
