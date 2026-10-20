# Managed credentials refusal (VUH-2576)

The real HTTP integration test uses Hono's network server, the real Pi model
runtime and the file credential broker. It proves managed native-login and
customer-key/model mutations return `403 managed_credits_only`, listings hide
those choices, unauthenticated requests stay refused, and stored credentials
survive. The self-hosted path accepts a key and persists model selection.

An explicit manual run with `VUH2576_NATIVE_LOGIN=1` additionally starts the
installed Codex CLI through the self-hosted HTTP endpoint, waits for its actual
vendor authorization link, then cancels. The managed endpoint refuses the same
installed dependency. The test uses isolated HOME/CODEX_HOME and file credential
storage; it neither authorizes an account nor prints login links/codes.

Command (inside `clankie heavy --`):

```sh
env VUH2576_NATIVE_LOGIN=1 pnpm exec vitest run apps/clankie/test/managed-credentials-http.integration.test.ts
```

Result: all three tests passed. The manual native proof is opt-in because it
requires an installed CLI and vendor network access. The ordinary landing gate
runs the two local HTTP/broker tests and the existing captured-CLI regressions.
This is service/API evidence, not a production rollout or a completed account
sign-in. Native Claude login continuity is covered by the existing captured-CLI
integration, not a live Claude account sign-in.

The private managed routing/forwarder patch is prepared separately for lead
review. Actual-model/rate credit projections remain VUH-1890/VUH-2107.
