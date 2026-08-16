# packages/model-provider/src/oauth/anthropic.ts

Claude Pro/Max subscription OAuth for the
`anthropic` provider — the manual-code PKCE flow:
Anthropic's console displays an
`authorization-code#state` value the operator
pastes back.

- `createAnthropicAuthorization` /
  `buildAnthropicAuthorizeUrl` /
  `generateAnthropicPkce` — URL + in-memory
  verifier/state.
- `exchangeAnthropicCode` — validates the pasted
  state against the original (CSRF) before the
  JSON token exchange.
- `runAnthropicBrowserLogin` — opens the URL,
  reads the pasted code via callback, persists
  the oauth credential through the broker; no
  token returns to the UI layer.
- `refreshAnthropicToken` — refresh grant,
  preserving the prior refresh token when
  rotation omits one.
- `createAnthropicFetch({store})` — per-request
  adapter: reads the broker every request (so
  local revocation is immediate), single-flight
  refresh when expired, strips `x-api-key`, sets
  the subscription Bearer, and merges the
  required `anthropic-beta` feature flags
  (oauth, claude-code, interleaved-thinking,
  fine-grained-tool-streaming).

Selected by `configured-model.ts` only when the
anthropic credential is oauth-typed; API keys
keep the normal AI SDK path.
