# ADR 0012: Provider, auth, and model configuration

Status: accepted (James, 2026-07-10; VUH-756 umbrella).

## Decision

Captain model access is configured through three cooperating layers, borrowing opencode's proven designs where they fit (recon of `~/dev/opencode` in VUH-756):

1. **Model registry** (`packages/model-registry`) — the models.dev catalog fetched programmatically with a disk cache (5-minute TTL, atomic writes) and a vendored snapshot fallback, so the model list stays current without making network a requirement. Env escape hatches: `CLANKIE_MODELS_URL`, `CLANKIE_MODELS_PATH`, `CLANKIE_DISABLE_MODELS_FETCH`. Local/unlisted models overlay the catalog via custom-provider merge.
2. **Credential store** (`packages/credential-broker`) — a discriminated union (`api` | `oauth` | `wellknown`) behind a `CredentialStore` interface; macOS Keychain backend by default, 0600-file fallback elsewhere (`CLANKIE_CREDENTIALS_FILE` override). Secrets never appear in config files or logs (redaction helpers). This diverges deliberately from opencode's plaintext `auth.json`.
3. **Provider layer** (`packages/model-provider`) — non-secret config in `~/.config/clankie/clankie.json` with a per-repo override, deep-merged and zod-validated; provider resolution (credential present ∪ env var declared by the registry ∪ config-declared); Vercel AI SDK instantiation with `@ai-sdk/openai-compatible` as the universal adapter for local endpoints (Ollama, LM Studio/MLX, llama.cpp, vLLM — just `baseURL`); reasoning effort as per-model variants (`{id, headers, body}`) lowered to each API's wire format.

**Captain auth supports all three methods** (decided over API-keys-only): API keys, Anthropic Pro/Max subscription OAuth, and ChatGPT/Codex subscription OAuth with its ToS-critical request adaptation (endpoint reroute to the codex backend, `ChatGPT-Account-Id`/`originator` headers, single-flight lazy refresh). Worker harnesses are untouched by all of this: per ADR 0006 they are provider-native adapters whose own logins (Codex CLI, Claude Code, Pi) remain the source of worker auth; the `/auth` wizard guides those logins rather than re-implementing them.

OpenAI API-key and ChatGPT subscription access are separate provider
identities: `openai` and `openai-codex`. The latter projects the supported
verified Codex-backend model catalog with zero subscription cost and forces the Codex
Responses request contract (`instructions`, `store:false`, OAuth headers).
There is no implicit credential fallback between the identities.

The operator UX is the TUI's guided SetupFlow wizards (`/auth`, `/model`, `/effort`, later `/voice`), per ADR 0011. The live voice model for Discord calls has no baked-in default — `/voice` prompts (gpt-realtime, Grok voice agent, Gemini Live, local) and rides the same registry and credential store.

Session/context management follows ADR 0014: Eve owns durable conversation
history, replay, compaction, and step usage; the TUI stores a private channel
cursor and displays context usage from registry limits.

## Options weighed

- **Re-implementing worker OAuth in-house** — rejected: ADR 0006 makes harness-native logins authoritative; duplicating them adds ToS risk and maintenance for no capability.
- **Plaintext auth file (opencode's model)** — rejected for secrets at rest; Keychain was already committed (VUH-689). File fallback exists only for non-darwin/CI.
- **Hand-maintained model list (v1's hardcoded menus)** — rejected; models.dev gives cost/limits/modalities/reasoning metadata across 158 providers and refreshes programmatically.
- **Config in saved env vars (v1's `CLANKIE_*` env store)** — rejected in favor of typed, diffable JSON with global + repo override.

## Constraints

Only the runner/privileged connectors hold provider credentials (docs/01); workers receive scoped capability tokens (VUH-689/690). `@clankie/tui` reads config and drives wizards locally today; when the control plane owns provider state, the TUI switches to its API without changing the wizard UX.
