# Deliberate owner updates and issue navigation

[VUH-1809](https://linear.app/vuhlp/issue/VUH-1809), 2026-10-07.
Branch `vuh-1809-owner-updates`, fresh from main and rebased onto `3533b8da`.

Clankie chooses news through `mail_owner_update`; no event automatically mails
it. Updates contain title/body, optional links/media and issue reference,
host-bound conversation source and optional worker attribution. Owner-only
list/read/dismiss operations share the API, CLI and local/hosted TUI. Reading or
dismissing never resumes a run or resolves an ask. Asks accept the same optional
`issue: {tracker, key, url}` and preserve it across restart.

The atomic disk store reconciles exact publication identity/draft while retained.
Keep unread/read mail and 32 recent dismissed records within 256 records /
512,000 bytes per source, refusing capacity without evicting active mail.
Lists return up to 1000 newest-first entries across sources. URLs are HTTP/HTTPS
navigation references and grant no file, tracker or credential access.

The app's `vuh-1809-mailbox` branch was read without edits at
`packages/command-center/src/v2/mailbox/ownerMailbox.ts`. Its `MailUpdate` slot
expects `id`, `title`, optional `body`, `conversationId` and `at`. Core preserves
these fields, requires body and adds source, state, links/media and issue. The
app adapter unwraps `client.ownerUpdateList().updates` and awaits
`client.ownerUpdateDismiss(id)`; explicit read state and new navigation need app
binding. [ADR 0245](../../adr/0245-one-owner-ask-across-surfaces.md) defines this
contract; [CLI](../../cli.md#owner-updates) and
[route catalog](../../../apps/clankie/openapi.yaml) document it.

## Checks

Commands ran through `clankie heavy`. Focused coverage spans eight files:

- `apps/clankie/test/owner-updates.integration.test.ts`
- `packages/protocol/test/owner-updates.test.ts`
- `apps/tui/test/owner-updates-cli.integration.test.ts`
- `apps/clankie/test/ask-mailbox.integration.test.ts`
- `apps/clankie/test/multiple-owner-asks.integration.test.ts`
- `apps/clankie/test/mcp-tool-schema.test.ts`
- `apps/clankie/test/conversation-question-auth.test.ts`
- `apps/tui/test/question-commands.test.ts`

Protocol, service and TUI typechecks; 57 focused tests; scoped formatting/lint;
`pnpm docs:check` and `pnpm deadcode` passed. Final rebased run results are read
before landing.

New integration coverage uses the real registered tool, disk-backed store,
protocol client/result parser and CLI over local HTTP. It verifies no automatic
publication or continuation, durable restart, immutable publication reconciliation,
exact read/dismiss, unsafe URL refusal, issue distinction on otherwise identical
asks, record/byte capacity, dismissed pruning and 260 updates across sources.
The existing HTTP authorization fixture adds update operations through real
operator/device and hosted routes: operator and signed control device succeed;
captain-only, read-only, wrong hosted device, revoked and expired device refuse.
It reuses that fixture's captain adapter and legacy test spies; it does not claim
a live model/native-harness E2E.

No running service or app was deployed or restarted. The app branch was not
edited; mailbox service-slot binding and iPhone/iPad presentation stay in its lane.
