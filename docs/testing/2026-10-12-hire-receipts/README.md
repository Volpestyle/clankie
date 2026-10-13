# VUH-2180 hire receipt recovery

Private operator tools can settle another conversation's uncertain fresh hire.
Delegated conversations remain restricted to their own fresh hires; revoked
conversation authority refuses recovery. `release-allocation` is a distinct
operator disposition for project bookkeeping, and never claims native delivery.

Successful remote hires retain their native receipt. Closing an owned pane or
observing its absence in the next complete native census retires only completed
receipts on the same configured host target. A distinct fresh intent must refer
to the latest retained receipt and carry a new brief. Uncertain dispatches remain
held across restart; neither retirement nor recovery resends anything.

## Passing proof

The manual `hire-receipt-retirement-native.integration.test.ts` uses a real owned
Herdr daemon and the actual remote host receipt program on this Mac. Both close
and harvest cases passed. It proves other-owner operator recovery, delegated and
revoked-authority refusal, complete live/absent pane census, configured host
replacement refusal, new intent admission and restart without uncertain replay.

The completed record is grounded in the actual successful KH2 hire
`f2318241-6fe9-4229-8df5-b992d69fea37` / native receipt
`7c81bd08-1d41-4cff-b4a3-01f81ab329ce`. The test restores that golden into a
separate journal and translates its target, directory and pane to owned isolated
Herdr resources. This proves the bookkeeping boundary, not a new successful
native Codex hire. After admission the fixture's native preparation policy
refuses intentionally; a retry cannot launch again.

The existing fresh-hire golden suite passed 6/6 and remote-hire-receipts
integration suite passed 17/17, including real host journals and Herdr inventory.
The service typecheck passed its source program and all 13 test partitions.
Touched-file formatting and lint passed. `focused-checks.txt` and
`typecheck-report.json` retain the check results. The assigned integrator runs
the repository-root landing gate against the exact integration tree.

Run the native boundary proof explicitly:

```sh
HIRE_RECEIPT_NATIVE_TEST=1 clankie heavy -- pnpm exec vitest run apps/clankie/test/hire-receipt-retirement-native.integration.test.ts apps/clankie/test/fresh-hire-intent.integration.test.ts apps/clankie/test/remote-hire-receipts.integration.test.ts
```

Raw evidence includes `close/boundary-results.json`,
`harvest/boundary-results.json` and the corresponding owned Herdr logs. The small
completed golden lives with the test fixtures. The small captures are bundled by their original filenames in the uploaded
`receipt-proof.json` archive, referenced by `evidence.json`. The compiler report
is uploaded separately; this README is the tracked account of their meaning.

## Failed full-hire capture: isolated Herdr 0.9.3 manifest gap

`full-hire-failed.json` retains the unsuccessful native Codex cold-start attempt.
The native thread and interactive TUI existed, but isolated Herdr 0.9.3 with its
bundled 2026.09.23.1 manifest returned `codex_state_ambiguous` and unknown binding
status. The first brief never dispatched. The binding guard remains unchanged.
Production Herdr hires work: this worker was hired at 23:26Z. The lead explicitly
accepted the real census/close proof and completed-hire golden for landing,
while retaining this failed attempt and its limitation.

## One-time reconciliation

The existing operator recovery CLI released these four local project allocations
only after complete native pane-absent inventory:

- `678a7c7d-b52c-4742-84c8-e373fa588e26` — VUH-2174, the owner's named record.
- `bb081edc-10ac-4329-b96c-06d6ac48c022` — VUH-1925b.
- `81c84ebf-55ee-4ddc-873f-39375dd58062` — VUH-2126.
- `0deea8cf-5771-4a21-aa01-4073bff44d1a` — VUH-2174 lead inbox.

`named-allocation-reconciliation.json` captures the named record's persisted
operator release and census digest. The `reconcile-*.json` files retain the other
CLI results. Launch history was preserved; no sends, pane closes or replays.

Two local allocations stayed held because original native receipts remain
uncertain: `aced585c-a8ab-47fd-afee-757872da9b57` (VUH-2144) and
`53052cc6-6ee7-43c0-8540-c53c8cf36d91` (VUH-2029). Their refusal captures are
included. They require original native settlement before project release.

## Open live proof

No deploy and no PC writes were performed. Per the lead's instruction, the KH2
completed receipt remains pending the runtime update; no service journal was
hand-edited. After the lead deploys, the next fresh admission must retire it
through a complete census. The next real Mac hire → close → fresh cycle and
KH2 receipt retirement remain post-deployment live proof, to attach on VUH-2180.
The original remote PC cycle criterion is not claimed as tested by this work.

## Root-gate regression and correction

Integration batch `28341610-d12f-47ad-91ef-214272403a64` failed the root gate
on two OpenCode consumers, each failing again on the gate's rerun.
`failed-root-gate.log` retains that nonzero full-gate result. It is not a flaky
pass or a green landing gate.

The product correction archives completed ordinary remote receipts with their
original location, freeing the reusable recipient key while retaining host
admission and launch history. Fresh-hire identity retention remains mandatory.
Any uncertain sibling at that location blocks both ordinary and fresh dispatch;
a completed archive cannot bypass the uncertain fence. Locations with retained
fresh-hire history require a distinct fresh intent for later work, even after
explicit settlement. Fence refusals return the structured hire result before
any host reservation or dispatch. Post-close inventory is required when a project allocation or an
authenticated completed receipt on the original pane needs retirement; unmanaged
closes keep their existing behavior. Neither consumer test was changed.

The first attempted correction fixed unmanaged close but still failed the
prepare-drop case (67/68); `first-correction-failed.txt` retains that result.
Post-correction checks passed 68/68 across both OpenCode consumer files and the
three receipt proof files. The real Herdr proof additionally exercises ordinary
requests after uncertainty and after explicit settlement; neither bypass can
prepare or dispatch. `bypass-api-refusal-failed.txt` retains the intermediate
missing structured refusal found by that proof. Formatting and lint passed.
The original compiler report predates this correction; the replacement
integrator runs a new compiler/landing gate. The replacement batch is reported
on VUH-2180.
