# Multiple owner asks per conversation

[VUH-1809](https://linear.app/vuhlp/issue/VUH-1809) core follow-up, 2026-10-07.
Fresh worktree `vuh-1809-multi-asks`, rebased onto main `100616af`.

The existing conversation store now keeps multiple independent pending asks.
The API shape is unchanged: `input_list` returns newest-first cards with each
ask's `waitingOn`; answer/cancel still select request ID and incarnation with a
conversation revision. Refresh after sibling changes cause a revision conflict.
[ADR 0245](../../adr/0245-one-owner-ask-across-surfaces.md) records the decision.

All pending records and submitted/uncertain native claims survive pruning.
The 256-record / 512,000-byte conversation bound refuses new asks rather than
evicting them. Legacy preference/project questions retain their original fences.
Exact repeated drafts reconcile; different options, waitingOn and source
workspace remain distinct. Native identity deduplication remains global.

## Verification

All commands ran through `clankie heavy` on the rebased tree:

- `pnpm --filter @clankie/clankie typecheck`: passed.
- Focused Vitest run: six files, 48 tests passed, 7.26 seconds. Files:
  `multiple-owner-asks.integration.test.ts`, `ask-mailbox.integration.test.ts`,
  `conversation-questions.test.ts`, `operator-conversation-input.test.ts`,
  `conversation-question-auth.test.ts`,
  `worker-question-escalation.integration.test.ts` under `apps/clankie/test`.
- Scoped formatting and lint checks: passed.

The new integration fixtures use the real disk-backed ConversationStore,
ClaudeHookQuestions registry, escalation helper and protocol result parser.
Two native workers and Clankie's own asks coexist; owner answers resolve the
chosen native question and wake only its source with the correct authority.
The actual hook receipt timeout creates an uncertain claim, retained after
36 later settlements and store restart. Reordered answer maps reconcile without
a second dispatch. Late sibling answers refuse stale revisions and succeed only
after refreshing the same ID. Listing started before dispatch cannot cancel a
claimed answer when native reconciliation returns late.

Other cases cover reconciliation of a nonfirst worker resolved elsewhere,
retaining 40 open asks, exact-ID cancellation, fail-closed capacity, bulk source
cancellation, and legacy live-owner loss leaving independent mailbox asks open.
Native transport/model/UI E2E was not run; app mailbox work remains in its lane.
No deployment or service restart was performed.
