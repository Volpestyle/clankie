# VUH-1051: one upstream conversation tail

The relay now shares one captain tail per active conversation across JSON long
polls and NDJSON streams. Device cursors, limits, live-draft sequences, wait
deadlines and authorization remain independent. No device protocol, setting,
app change or CI workflow changed.

At source base `26a4c8a19afae9f47d9aa584e529f00a8a715fd5`, every device read
dispatched its own upstream tail. The new handler-owned hub bootstraps with an
immediate read and parks one canonical read within the protocol's 20-second
maximum. Its public event buffer is bounded by 1,000 events and 1 MiB; idle
entries expire after 60 seconds, with at most 256 conversations. Backward,
unknown and evicted cursors use immediate authoritative replay. Native cursor
identities are never sorted, and reused activity cursors rebase the cache.

Disconnecting the last subscriber aborts the HTTP hop, captain polling and
store waiter. Disconnecting one subscriber preserves the others. Cancellation
is read-only: it does not interrupt an accepted turn. An already-running
native file read can finish once, but cancellation prevents another poll or
source update. Expected HTTP disconnects do not become Hono 500 error logs.

## Verification

**116 tests in six files passed, with no failures or skips.** Protocol, relay
and Clankie typechecks and nine-file scoped lint passed. Installs, tests,
typechecks and the scanner timing probe used the fleet heavy limiter; package
typechecks ran sequentially. A real isolated install was used. Compact results
are in [checks.json](checks.json); raw reports/logs remain in the ignored
`.local/relay-tail-proof/` directory.

The 13 new integration cases use real TCP listeners, pairing offer/redeem/
complete, signed device authorization, actual revocation and conversation
state, plus real native journal parsing and cursor projection. They prove:

- Three paired devices share one parked upstream request across JSON and
  NDJSON; two active conversations park two requests.
- Surface IDs, event ordering, page limits, history and reconnect cursors are
  preserved. Native hashes and status-only cursor reuse remain correct.
- Live-draft sequences and wait deadlines belong to each reader. Settled
  records replace drafts without persisting the draft.
- Invalid cursors and native session replacement do not reset unrelated
  subscribers. Revoked devices receive no shared event.
- One disconnect leaves its peer subscribed; the last aborts the actual HTTP
  request. Store listener cleanup and accepted-turn survival also pass.
- Backward and byte-evicted history use replay while the single tail remains
  parked; zero-wait reads do not inherit another reader's wait.

From the worktree root:

```sh
/Users/james/.herdr-handoffs/clankie-backlog-20261003/bin/heavy pnpm exec vitest run --config vitest.config.ts apps/relay/test/operator-conversations.test.ts apps/relay/test/conversation-tail-sharing.integration.test.ts apps/clankie/test/operator-conversation-tail.test.ts apps/clankie/test/captain-native-chat.test.ts apps/clankie/test/native-conversation.test.ts apps/clankie/test/delivered-files.test.ts --reporter=default --reporter=json --outputFile=.local/relay-tail-proof/tests.json
/Users/james/.herdr-handoffs/clankie-backlog-20261003/bin/heavy pnpm --workspace-concurrency=1 --filter @clankie/protocol --filter @clankie/relay --filter @clankie/clankie typecheck
pnpm exec oxlint --deny-warnings apps/clankie/src/app/conversation-routes.ts apps/clankie/src/captain/captain-operator-service.ts apps/clankie/src/captain/conversations/store.ts apps/clankie/src/captain/port.ts apps/clankie/src/delivered-files.ts apps/clankie/test/operator-conversation-tail.test.ts apps/relay/src/conversation-tail-hub.ts apps/relay/src/operator-conversations.ts apps/relay/test/conversation-tail-sharing.integration.test.ts
```

## CPU defect found by the large-history case

The byte-eviction case appends 80 protocol-valid native messages, each containing
a 15,000-character plain word, totaling over 1 MiB. It initially failed with a
real `auth_failure: unavailable`: an authorization HTTP request timed out after
7,995.85 ms despite its 5-second timeout. The event loop was blocked inside
`namedImagePaths`, whose bare-path regex retried a failing image suffix at every
character of each word.

A heavy-wrapped probe of four scanner calls measured 34.78, 119.81 and 459.23 ms
for 4,000, 8,000 and 16,000 characters respectively. Restricting the bare-path
branch to token boundaries reduced those measurements to 0.27, 0.10 and
0.19 ms. The same large-history HTTP case then passed with authorization
unchanged; the existing image-delivery golden and real file-boundary checks
also passed. The native history workload exposed a separate blocking bug;
these data do not establish the cause of an earlier live idle-CPU incident.

## Limits

No owner-runtime mutation, live native hiring, model call, simulator, app repo
access or AWS action occurred. The HTTP fixtures exercise actual service
routes and data boundaries through an isolated captain port; they are not a
fresh physical-device or live-harness proof. Existing captain native-chat
checks retain their existing injected watch/census dependencies. The full
`pnpm check` and composed integration gate remain with the integrator.
