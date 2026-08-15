# packages/model-provider

`@clankie/model-provider` — turns clankie config
plus the model-registry catalog and
credential-broker credentials into ready-to-call
AI SDK language models. A four-layer pipeline:
config (load/merge/validate) → resolve (providers,
roles, subscription precedence) → variants
(reasoning presets) → instantiate (AI SDK
factories), with provider OAuth flows alongside.

Children:

- README.md — full pipeline doc with a mermaid
  flowchart, the OpenAI effort-ladder tables, and
  subscription-precedence rules
- package.json — AI SDK deps + workspace deps on
  credential-broker and model-registry
- tsconfig.json — typecheck-only build
- src/
  - config.ts — layered clankie.json/.clankie.json
    loading; secrets rejected by schema
  - resolve.ts — merged catalog, provider
    connection states, role resolution,
    ChatGPT-subscription precedence
  - variants.ts — per-model reasoning-effort
    ladders and thinking budgets
  - instantiate.ts — AI SDK factory selection and
    variant lowering to providerOptions
  - configured-model.ts — the top-level
    `resolveConfiguredLanguageModel` entry point
  - codex-catalog.ts — the verified Codex
    subscription model list
  - codex-model-probe-cli.ts — opt-in backend
    probe (`pnpm models:codex-probe`)
  - oauth/ — ChatGPT/Codex and Anthropic Pro/Max
    subscription OAuth + fetch adapters
- test/ — five suites across the layers

Invariants: secrets never live in config (schema
rejects secret-shaped keys, pointing at /auth and
the broker); construction never throws for
missing credentials (placeholder keys fail at
call time); a stored ChatGPT subscription
supersedes the metered OpenAI key for models the
Codex backend serves.
