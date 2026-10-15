# VUH-2310 usage recovery

Tracks: https://linear.app/vuhlp/issue/VUH-2310

The existing account reader supplies both fleet notices and each Auto wake. A
lead's accepted warning retains its window and observation; a newer reading
that reports a reset or pace lasting through reset produces one recovery notice.
A refused delivery stays pending. Previously warned leads remain checked even
when their last worker finishes. No extra collector or timer was added.

## Verification

- `clankie heavy -- pnpm exec vitest run apps/clankie/test/worker-accounts.integration.test.ts apps/clankie/test/auto-velocity.integration.test.ts apps/clankie/test/runtime-provider.integration.test.ts`: 3 files, 24 tests passed.
- Focused reset/pace/warning run: 3 passed. The end of `focused.log` contains the production
  notice and Auto prompt output for the acceptance scenario: 84% used before
  reset → 2% used after reset; one recovery; 98% left in Auto; repeat count 0.
- The reset scenario is grounded in the existing October 9 account example,
  advanced to a reported next window. It exercises production notice state and
  prompt generation without mocks. It also checks missing usage, signed-out,
  unknown and held-account observations do not falsely recover capacity.
- The runtime-provider suite runs the real app, captain, native event channel,
  HTTP and durable stores in isolated fixture homes; its Auto routing test
  verifies the capacity section reaches both configured lead and fallback head.
- The lead plugin's `skills/lead` is a symlink to `.agents/skills/lead`, so its
  instruction and reference update together.

`focused.log` is archived in the evidence store. Landing-gate
result and the pushed revision are recorded on the issue after landing.

## Scope

No live account was reset or changed, and no installed service was restarted.
The recovery scenario uses an explicit next-window reading; it does not claim
an observed vendor reset. Warning/recovery delivery state retains the existing
service-lifetime deduplication boundary.
