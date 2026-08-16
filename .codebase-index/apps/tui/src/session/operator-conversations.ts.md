# apps/tui/src/session/operator-conversations.ts

The production plain-prompt path: the TUI speaks the
shared `OperatorConversationServiceClient` contract
from `@clankie/protocol` over the clankie service's
authenticated dispatch route (`createCaptainRouteClient`
attaches the brokered captain bearer;
`resolveCaptainRouteToken` degrades to token-less
loopback on failure).

Pieces:

- `createCaptainOperatorConversationClient` — POSTs
  the dispatch path, schema-validates every result.
- `OperatorConversationSelection` — select by id
  (server-confirmed), default-global, create.
- `OperatorConversationSelectionStore` — persisted
  selected id; fail-closed (only ENOENT is "no
  selection"), atomic 0600 writes.
- `OperatorConversationTailStore` — the durable
  per-surface tail: a stable `tui-<uuid>` surface
  client id plus one opaque cursor per conversation
  (max 256), so restart and switching resume the
  exact server-owned log boundary.
- `resolveInitialConversation` — `--chat` id (server
  confirmed) → persisted selection (dropped if gone)
  → default global.
- `parseDirectConversation` — `--chat` argv parsing.
- `OperatorConversationPromptSession` — per prompt:
  snapshot the selection, replay unread history
  (recovery pages fail the send), send with the
  current revision fence, then consume the typed
  tail until this run's terminal turn event.
  Aborting observation never cancels the accepted
  turn.
