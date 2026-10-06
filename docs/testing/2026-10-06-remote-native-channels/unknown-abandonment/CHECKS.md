# Explicit unknown abandonment (VUH-1527)

Clankie approved authenticated unknown abandonment followed by separately new
acceptance, with the original permanently fenced. The new operator/CLI
disposition is `abandoned-unknown`; its retained evidence has unknown allocation
fate and explicit `freshIntentAllowed: true`. It cannot carry a guessed pane,
`present: false`, native delivery or a no-launch claim.

The service accepts only an inactive, unmapped fresh remote Codex original with
its retained admission and irreversible launch commitment. Recovery fencing is
durable before further awaits. The configured host requires the exact existing
claim/nonce and launching history, observes a complete stable pane/agent/process
census under the journal lock, and preserves original evidence and history.
Recovery after a lost local commit appends a fresh census. Separate fresh work
retains every existing UUID, body, owner, project, launch, target and sibling
check. No original reserve, launch, brief or adoption is retried.

Source verification passed:

- `heavy env HIRE_RECEIPT_NATIVE_TEST=1 pnpm exec vitest run --config
vitest.config.ts apps/clankie/test/remote-hire-receipts.integration.test.ts
apps/clankie/test/fresh-hire-intent.integration.test.ts
apps/clankie/test/hire-brief-receipt.test.ts`: **28 tests / 3 files passed**,
  including the real isolated Herdr/OS census, authenticated host program,
  CLI/HTTP route, post-host authority revocation and separately new admission.
  Duration 9.26 seconds. The native case was enabled and passed.
- Protocol, Clankie and TUI `typecheck`: **passed**. Every typecheck and test
  command used `/Users/james/.herdr-handoffs/clankie-backlog-20261003/bin/heavy`.
- Scoped `oxlint --deny-warnings` for all ten changed source/test files:
  **passed**. Scoped formatting, local documentation links and diff checks:
  **passed**.
- [Native security review](SECURITY-REVIEW.md): **approved**, no blockers.

The integration retains the exact first host proof when authority is revoked
before local settlement, then verifies that recovery produces a newer census.
Wrong nonce, absent journal, sealed history, guessed allocation and conflicting
retained disposition refuse. Strict schemas reject unknown evidence disguised
as mapped abandonment or without the explicit grant. Original identity/launch
flags survive restart, original begin/reconcile refuse, and a different fresh
intent reaches the independent preparation gate.

Deployed PC settlement of `3989da1d` and the full new-intent acceptance remain
pending. [The prior live failure](../live/c72c3d02/README.md) remains unchanged as
failure evidence. The [conditional root checks](../live/c72c3d02/root-checks.json)
verified idle state and an empty draft; ownership could not be proven, so
`wH:p1` remains open and was reported to Clankie. Unknown abandonment grants no
cleanup authority. No full `pnpm check`, eval, simulator, account/config change,
desktop action or unrelated pane mutation ran.
