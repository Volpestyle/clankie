# packages/model-provider/src/codex-catalog.ts

The verified ChatGPT-subscription model set.
`CODEX_SUBSCRIPTION_MODEL_IDS` lists only models
proven callable by Clankie's own `originator`
identity via the probe CLI (ADR 0014 —
first-party Codex client visibility is not
evidence). `codexSubscriptionModelIdFor` maps an
id to its subscription slug (bare `gpt-5.6` →
`gpt-5.6-sol`; the backend answers only by size
slug). `withCodexSubscriptionProvider(catalog)`
adds an `openai-codex` provider beside `openai`
containing just those models at zero cost and the
backend's own 400k/272k-in/128k-out window rather
than the larger API-key window models.dev
reports.
