# packages/model-provider/src/oauth/openai-codex.ts

ChatGPT/Codex subscription OAuth for the
`openai-codex` provider (ported from opencode's
Codex plugin). Credential lives in the broker
under `openai-codex`, deliberately distinct from
`openai` so an API key and the subscription
coexist.

- `runCodexBrowserLogin` — localhost callback
  server (default port 1455), PKCE S256, CSRF
  state check, code exchange; the server always
  shuts down on success/failure/timeout.
- `runCodexDeviceLogin` — headless RFC 8628-style
  flow: user code, polling through
  authorization_pending/403/404, `slow_down`
  growing the interval, bounded by a deadline.
- `refreshCodexToken` / internal refresh —
  rotates the refresh token, preserving accountId
  and the old refresh token when the response
  omits them.
- `createCodexFetch({store, sessionId?})` — the
  adapter `configured-model.ts` injects: reads
  the credential per request, refreshes once when
  expired (concurrent callers share one in-flight
  refresh, result persisted back), strips any
  inbound authorization header, sets the
  subscription Bearer, ChatGPT-Account-Id,
  `originator`, User-Agent, and session-id
  headers, and reroutes /responses and
  /chat/completions paths to
  `https://chatgpt.com/backend-api/codex/responses`.
- Helpers: `generateCodexPkce`,
  `buildCodexAuthorizeUrl`,
  `extractCodexAccountId` (JWT claim precedence).
