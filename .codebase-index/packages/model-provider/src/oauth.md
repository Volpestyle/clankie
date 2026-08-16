# packages/model-provider/src/oauth

Provider subscription OAuth flows. Both modules
follow the same shape: PKCE login flows, refresh
with single-flight sharing, broker persistence,
and a fetch adapter that attaches the
subscription bearer at request time so the AI SDK
only ever sees a placeholder key.

- openai-codex.ts — ChatGPT/Codex subscription:
  browser + headless device flows, request
  rerouting to the Codex backend
- anthropic.ts — Claude Pro/Max: manual-code
  browser flow, beta-header injection
