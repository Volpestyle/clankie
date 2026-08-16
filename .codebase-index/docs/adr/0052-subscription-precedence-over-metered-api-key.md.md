# docs/adr/0052-subscription-precedence-over-metered-api-key.md

While a ChatGPT-subscription credential is
stored, `openai/<model>` refs redirect to
`openai-codex/<model>` for every model the Codex
backend serves — an identity redirect, never
credential borrowing, so ADR 0014's no-fallback
rule stands.

Read when touching model resolution or billing
surfaces. The redirect is always stated (`/model
status`, selection output, the per-turn
`model_selected` ledger event); metered access
returns via logout or provider opt-out in config;
Anthropic needs no equivalent because both auth
methods share one credential slot.
