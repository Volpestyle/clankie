# apps/tui/bin/clankie.ts

The `clankie` command entry point. Fills the process
env from the Discord settings store (the launcher
itself reads tunnel config, so an unfilled env once
silently disabled a configured tunnel), parses and
strips `--chat <conversationId>`, then either
dispatches a headless subcommand
(`runHeadlessCaptainCommand`) or opens the operator
console.

Console path: renders a spinner status line on
stderr, ensures the operator credential and (best
effort) the brokered captain token, health-gate
starts the clankie service via `startOne("clankie")`,
then dynamically imports `../src/index.ts`. Startup
failure prints one message and exits 1; a captain-
token brokering failure degrades instead of blocking.
