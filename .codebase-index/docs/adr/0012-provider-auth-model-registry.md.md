# docs/adr/0012-provider-auth-model-registry.md

Captain model access as three layers:
`model-registry` (models.dev catalog, disk cache,
vendored fallback), `credential-broker` (Keychain
store, api|oauth|wellknown union, never
plaintext), and `model-provider` (zod-validated
config, Vercel AI SDK, openai-compatible for
local endpoints).

Read when touching auth, model selection, or
credentials. Key rulings: API keys plus Anthropic
and ChatGPT-subscription OAuth are all supported;
`openai` and `openai-codex` are separate provider
identities with no implicit credential fallback;
the broker also owns the `clankie_operator`
bearer. Pre-rewrite text mentions workers and the
control plane.
