# packages/model-provider/src

Pipeline source. Data flows config.ts →
resolve.ts → variants.ts → instantiate.ts, with
configured-model.ts composing all four into the
one call the captain makes, and oauth/ supplying
the subscription fetch adapters.

- index.ts — barrel (`export *` of every module)
- config.ts — layered config, model refs, secret
  rejection
- resolve.ts — catalog merge, provider
  connections, roles, subscription precedence
- variants.ts — reasoning presets per provider
  family and model
- instantiate.ts — AI SDK factory dispatch,
  Codex Responses wrapper, variant lowering
- configured-model.ts —
  `resolveConfiguredLanguageModel`
- codex-catalog.ts — verified subscription model
  set and backend window
- codex-model-probe-cli.ts — streamed backend
  probe CLI
- oauth/ — openai-codex.ts, anthropic.ts, xai.ts
