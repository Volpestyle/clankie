# VUH-1926: one owner turn, one execution driver

Tracks [VUH-1926](https://linear.app/vuhlp/issue/VUH-1926).

The current service/native admission fence already selects one execution driver.
This change pins that behavior with a regression; it changes no runtime policy.
The lead explicitly narrowed the assignment to this proof after the original
incident receipts could not be recovered.

The source snapshot, positive and negative-control logs, and bounded trace
summary are in the archived `proof.json` listed in [evidence.json](evidence.json).

## Regression

`apps/clankie/test/owner-app-seat-turn.integration.test.ts` sends one authenticated
owner app turn while a native mailbox is completing admission. The service runner
gets its routing opportunity while native preparation is pending. It must wait,
then deliver the turn once to the native mailbox without starting a service model.
The receiver calls `linear_save_issue` through the real operator MCP HTTP route.
The built-in tracker persists one issue; reopening the backend confirms that
effect. The test also checks one dispatch, one owner message, one completed turn,
and an empty mailbox after acknowledgment.

The test uses real authentication, conversation admission, routing, MCP protocol
and durable tracker storage. Its protocol receiver represents the native bridge;
it does not launch Claude or write to the owner's connected Linear account.
The existing fixture's service model entry throws if selected. No model is mocked.

## Checks

All heavy commands ran through `clankie heavy --`.

```sh
clankie heavy -- pnpm exec vitest run apps/clankie/test/owner-app-seat-turn.integration.test.ts
```

Result: 9 tests passed. As a negative control, the native admission wait in
`runWithConversationDriver` was temporarily removed and only the new test ran.
It failed with `Owner turn settled without native delivery`; the service tried
to start its model before native admission finished. The original runtime source
was restored before the final checks and is not part of this change.

The root landing gate and pushed integration commit are recorded on the issue.
Landing uses `clankie integrate --push`.

## Historical limit

The issue records VUH-1924 at `2026-10-09T05:12:27.144Z` and VUH-1925 at
`2026-10-09T05:12:36.337Z`. Its later comment attributes these to the native main
turn and a `/btw` fork, correcting the original service-lane assumption.
The brief trace pass found no matching original receipt in the retained
conversation events, worker reports, service histories or inspected native
journals. Current reports only mention this investigation. The lead also had no
original receipts. That attribution cannot be independently confirmed here.

Claude Code 2.1.296 is installed on this Mac. Anthropic's
[current `/btw` documentation](https://support.claude.com/en/articles/14554000-claude-code-power-user-tips)
describes a single-turn side question without tool calls. That does not establish
what the historical session did. This proof covers the current service/native
fence, not historical fork dispatch, arbitrary repeated owner requests, or a new
interactive Claude session. The issue can close as covered by the existing fence
with this historical limit retained, per the lead's revised acceptance.
