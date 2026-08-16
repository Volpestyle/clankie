# apps/tui/src/provider-commands.ts

The provider/model configuration commands:
`buildProviderCommands` returns `/auth`, `/provider`,
`/model`, `/effort`, `/image-model`, `/video-model`;
`createProviderServices` bundles the credential
store, model registry, and OAuth runners.

- `/auth` — masked API-key entry (featured LLM
  providers plus the `elevenlabs` service
  credential, or any typed provider id), ChatGPT/
  Codex OAuth (browser or device code), Claude
  Pro/Max OAuth (browser or manual code), harness
  login guidance, and removal. Secrets go only to
  the broker and render only redacted.
- `/provider` and `/model` — two-step role pickers
  (roles: model, small_model, voice_model) over
  models.dev via `@clankie/model-registry`, writing
  `provider/model` refs to clankie.json through
  `updateGlobalConfig`; both offer an inline registry
  refresh. Provider intent pending `/model` is
  process-local only.
- `/effort` — reasoning-variant override per model
  ref, or clear to provider default.
- `/image-model`, `/video-model` — positional (ADR
  0085): one usable model per provider
  (`MEDIA_MODELS`), a typed model id wins over the
  default, `status`/`unset` supported; the service
  reads the ref per request so no restart.

`servedBySubscription` surfaces the precedence rule
in status output: a stored `openai-codex` credential
serves matching `openai/...` refs
(`openai/gpt-5.5 → openai-codex/gpt-5.5`).
