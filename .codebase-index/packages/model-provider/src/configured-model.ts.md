# packages/model-provider/src/configured-model.ts

The pipeline's front door:
`resolveConfiguredLanguageModel(options)` loads
config, resolves the requested role, applies
subscription precedence (keychain read only for
refs the subscription could serve), merges the
catalog, checks a credential/baseURL/env source
exists, resolves the selected variant, and
constructs the model — `createCodexLanguageModel`
with the codex fetch adapter for `openai-codex`,
otherwise `createLanguageModel`, wiring the
Anthropic OAuth fetch adapter when the anthropic
credential is oauth-typed.

Returns `ConfiguredLanguageModel`: ref,
provider/model ids, the LanguageModel, context/
output token limits from the catalog, and the
variant's per-call `modelOptions`. Failures are
typed `ConfiguredModelError`s with operator-
actionable messages ("run /model", "run /auth").
Also exports `CAPTAIN_CODEX_PREAMBLE`, the
instructions constant the Codex wrapper injects.
