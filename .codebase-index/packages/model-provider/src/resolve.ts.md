# packages/model-provider/src/resolve.ts

Providers and roles.

- `mergedCatalog(config, catalog)` — injects the
  Codex subscription provider, then overlays
  config-declared providers/models via
  `applyCustomProviders`. Only catalog-shaped
  data crosses; `options` (baseURL etc.) stays
  config-side.
- `resolveProviders(input)` — drops
  disabled_providers, applies a non-empty
  enabled_providers allowlist, and marks each
  survivor's connection: `credential` (broker
  holds one), `env` (declared env var set), or
  `none`. Connected sort first, then by name.
- `resolveRole(role, input)` — resolves a
  configured role ref to {providerId, modelId,
  catalog model, variantId}. `ModelRole` is the
  language-model roles; `MediaModelRole`
  (image/video) is kept a separate type so the
  language-model instantiation path cannot
  typecheck against a media ref.
- Subscription precedence —
  `subscriptionRefFor(role, config)` names the
  `openai-codex/…` ref that supersedes an
  `openai/…` ref (pure; the bare gpt-5.6 alias
  maps to gpt-5.6-sol), respecting the
  disabled/enabled opt-outs;
  `subscriptionOverrideFor` applies it once the
  caller confirms a stored subscription
  credential, carrying the configured effort
  across.
