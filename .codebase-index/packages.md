# packages

Shared contracts and adapters consumed by the apps. `protocol` is the process-contract base; runtimes and transports layer above it, while security, settings, model, media, and observability packages provide infrastructure.

- `api-client/` — typed, validating HTTP client for the Clankie service.
- `body-lock/` — cross-process single-holder GBA lock and observer.
- `credential-broker/` — Keychain/file secret storage, capability tokens, internal bearers, and OAuth.
- `discord-presence-core/` — transport-neutral Discord text, presence, voice, music, actions, and receipts.
- `environment-runtime/` — durable lease and lifecycle enforcement for embodied sessions.
- `interactive-environment/` — provider-neutral environment, GBA, presence, surface, and play-sight contracts.
- `media-connector/` — bounded image/video generation adapters and artifact handling.
- `model-provider/` — settings and credentials to ready-to-call model instances.
- `model-registry/` — cached models.dev catalog and query helpers.
- `observability/` — Pino logging, secret redaction, and support-bundle sanitization.
- `possessor-voice/` — authenticated, lossy gameplay commentary/hearing seam.
- `protocol/` — dependency-light Zod schemas and cross-process types.
- `rendered-surface-client/` — dial-out gameplay frame and overlay publisher.
- `settings/` — owner-authored, non-secret settings and persona configuration.
- `vox-client/` — Apache TypeScript lifecycle and typed IPC client for AGPL Vox.
