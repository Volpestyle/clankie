# apps/discord-bridge/src/live-proof-cli.ts

`pnpm discord:live-proof` entrypoint: reads the
receipt log (DISCORD_BRIDGE_RECEIPT_PATH or the
XDG state default), runs evaluateDiscordLiveProof,
prints PASS/FAIL per check or `--json`, exits 1
when incomplete.
