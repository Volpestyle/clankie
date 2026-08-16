# packages/model-provider/src/instantiate.ts

AI SDK construction.

- `providerFamilyFor(provider, baseURL?)` — picks
  the factory family; an explicit baseURL or
  `npm: "@ai-sdk/openai-compatible"` always
  routes through the generic OpenAI-compatible
  factory, unrecognized providers too.
- `createLanguageModel(input)` — dispatches to
  createAnthropic / createOpenAI / createGoogle /
  createXai / createOpenAICompatible. Never
  throws for missing credentials: api/wellknown
  credentials supply the key, oauth gets the
  `clankie-oauth` placeholder (real bearer comes
  from the injected fetch wrapper), else the
  first set provider env var, else
  `clankie-unconfigured` — so listing/selection
  flows stay total and the request fails with the
  provider's own auth error.
- `createCodexLanguageModel(input)` — wraps the
  OpenAI Responses model in middleware that
  force-fills the backend's non-optional
  `instructions` and sets `store: false`.
- `variantProviderOptions(variant, family)` —
  lowers a wire-format variant body into
  `{providerOptions, headers}` for generateText/
  streamText, camelizing keys
  (`reasoning_effort` → `reasoningEffort`) under
  the family's namespace (`openaiCompatible` for
  the generic factory).
