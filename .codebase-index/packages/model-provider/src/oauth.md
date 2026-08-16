# packages/model-provider/src/oauth

Provider subscription OAuth flows and fetch
adapters. Each reads broker state at request
time, rotates credentials back into the store,
and keeps real bearers out of AI SDK model
configuration.

- `openai-codex.ts` — ChatGPT/Codex browser and
  headless device flows, refresh, and Responses
  rerouting to the Codex backend.
- `anthropic.ts` — Claude Pro/Max manual-code
  PKCE, single-flight refresh, revocation, and
  required beta headers.
- `xai.ts` — SuperGrok/X Premium RFC 8628 device
  flow, expiry-aware single-flight refresh, and a
  request adapter that replaces the SDK's
  placeholder bearer.
