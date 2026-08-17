# ADR 0012: Provider, auth, and model configuration

Status: accepted (James, 2026-07-10; VUH-756 umbrella).

## Decision

Model access is configured through three cooperating layers:

1. **Model registry** (`packages/model-registry`) — the models.dev catalog fetched programmatically with a disk cache (5-minute TTL, atomic writes) and a vendored snapshot fallback, so the model list stays current without making network a requirement. Env escape hatches: `CLANKIE_MODELS_URL`, `CLANKIE_MODELS_PATH`, `CLANKIE_DISABLE_MODELS_FETCH`. Local/unlisted models overlay the catalog via custom-provider merge.
2. **Credential store** (`packages/credential-broker`) — a discriminated union (`api` | `oauth` | `wellknown`) behind a `CredentialStore` interface; macOS Keychain backend by default, 0600-file fallback elsewhere (`CLANKIE_CREDENTIALS_FILE` override). Secrets never appear in config files or logs (redaction helpers). This diverges deliberately from opencode's plaintext `auth.json`.

The same store owns the host-local `clankie_operator` bearer. First-run bootstrap
mints it with 256 bits of entropy, operator clients auto-load it, and the
service authorization boundary resolves it per request so one broker rotation
invalidates prior local credentials immediately. Environment input is an
explicit CI/test override and health exposes only content-free consistency.

3. **Provider layer** (`packages/model-provider`) — non-secret config in
   `~/.config/clankie/clankie.json` with a per-repo override, deep-merged and
   zod-validated; provider resolution (credential present ∪ env var declared by
   the registry ∪ config-declared); Pi provider projection for the captain; AI SDK instantiation for gameplay, voice, and media with
   `@ai-sdk/openai-compatible` as the universal adapter for local endpoints
   (Ollama, LM Studio/MLX, llama.cpp, vLLM — just `baseURL`). The captain uses Pi's native thinking levels; non-captain AI SDK adapters lower their provider options at request time.

**Captain auth supports four methods:** API keys, Anthropic Pro/Max subscription OAuth, ChatGPT/Codex subscription OAuth with its request adaptation (Codex backend, `ChatGPT-Account-Id`/`originator` headers, single-flight lazy refresh), and SuperGrok / X Premium device-code OAuth on the same `xai` slot as an API key (RFC 8628 against `auth.x.ai`, Bearer against `api.x.ai/v1`, no endpoint reroute). Coding-agent harnesses keep their native logins; the `/auth` wizard guides those logins rather than re-implementing them.

OpenAI API-key and ChatGPT subscription access are separate provider
identities: `openai` and `openai-codex`. The latter projects the supported
verified Codex-backend model catalog with zero subscription cost and forces the Codex
Responses request contract (`instructions`, `store:false`, OAuth headers).
There is no implicit credential fallback between the identities.

The operator UX is the TUI's guided setup (`/auth`, `/provider`, `/model`,
`/effort`, and `/voice`). Voice configuration uses the same registry and
credential store. Local endpoints are declared in the same `/provider` modal:
it writes the `baseURL` provider entry and seeds its models from the
endpoint's own `GET {baseURL}/models`, since models.dev has no catalog for a
machine-local runtime.

Session/context management follows the [architecture](../architecture.md): Pi
owns the captain's language-model runtime, durable conversation history,
compaction, and step usage; the TUI stores a private conversation cursor and
displays Pi's context limits
([ADR 0101](0101-pi-owns-the-captain-model-runtime.md)).

## Options weighed

- **Re-implementing coding-agent OAuth in-house** — rejected because each
  harness's native login is authoritative; duplicating it adds ToS risk and
  maintenance for no capability.
- **Plaintext auth file (opencode's model)** — rejected for secrets at rest; Keychain is already committed (VUH-689). File fallback exists only for non-darwin/CI.
- **Hand-maintained model list (v1's hardcoded menus)** — rejected; models.dev gives cost/limits/modalities/reasoning metadata across 158 providers and refreshes programmatically.
- **Config in saved env vars (v1's `CLANKIE_*` env store)** — rejected in favor of typed, diffable JSON with global + repo override.

## Constraints

Only the Clankie service and privileged connectors resolve provider credentials.
Coding-agent harnesses use their provider-native authentication. The TUI owns the local setup
flow and writes non-secret provider/model references to the settings store.
