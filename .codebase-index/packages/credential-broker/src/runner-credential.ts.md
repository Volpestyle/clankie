# packages/credential-broker/src/runner-credential.ts

The runner bearer (`clankie_runner_` + 256-bit
base64url) under `clankie_runner`, authenticating
runner-scoped service routes. Standard
mint/resolve/ensure pattern: the service mints on
first start; resolve refuses malformed stored
entries with a typed `RunnerCredentialError`.
`CLANKIE_RUNNER_TOKEN` in the environment still
wins when set (handled by callers), keeping tests
and deliberate overrides working.
