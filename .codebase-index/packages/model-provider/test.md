# packages/model-provider/test

Eight vitest suites across the pipeline layers,
all with stubbed fetch/stores — no network, no
real keychain.

- model-provider.test.ts — config loading/merge,
  secret rejection, refs, catalog merge, provider
  and role resolution, subscription refs, effort
  ladders
- configured-model.test.ts — the Codex provider
  overlay and end-to-end
  resolveConfiguredLanguageModel behavior incl.
  subscription precedence
- openai-codex.test.ts — PKCE, authorize URL,
  device flow, refresh, and the codex fetch
  adapter
- anthropic-oauth.test.ts — the manual-code flow,
  refresh, and the anthropic fetch adapter
- anthropic-configured-model.test.ts — brokered
  Pro/Max credential vs API-key path selection
- xai-oauth.test.ts — device login polling,
  refresh sharing/rotation/revocation, request
  bearer replacement, JWT expiry skew
- xai-configured-model.test.ts — SuperGrok OAuth
  adapter vs ordinary xAI API-key SDK path
