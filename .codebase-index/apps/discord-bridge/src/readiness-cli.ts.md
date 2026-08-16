# apps/discord-bridge/src/readiness-cli.ts

`pnpm discord:readiness` entrypoint. Builds the
broker store and an api client authenticated with
the brokered bridge credential, runs
inspectDiscordTextReadiness, and prints PASS/FAIL
lines with remediation (or `--json`). Exits 1
when not ready.
