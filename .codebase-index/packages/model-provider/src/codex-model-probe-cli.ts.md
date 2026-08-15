# packages/model-provider/src/codex-model-probe-cli.ts

Opt-in CLI (`pnpm models:codex-probe`) that
streams one throwaway turn per model/effort pair
through the real path — broker credential → codex
fetch adapter → Responses transport — and prints
the backend's own PASS/FAIL verdict. It is the
evidence ADR 0014 requires before
`CODEX_SUBSCRIPTION_MODEL_IDS` grows.
Credential-bearing, never in CI.

Each probe writes a throwaway config under a temp
XDG_CONFIG_HOME declaring its target (so an
unexposed candidate id still reaches the backend
and returns the refusal reason), uses a fixed
probe session UUID, and honors `--all-efforts`,
`--json`, and `model@effort` targets. Exit code 1
when any probe fails.
