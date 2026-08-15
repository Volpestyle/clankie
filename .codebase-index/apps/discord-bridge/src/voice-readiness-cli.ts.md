# apps/discord-bridge/src/voice-readiness-cli.ts

`pnpm discord:voice-readiness` entrypoint. First
fills unset DISCORD_* env from operator settings
(so it inspects the configuration the bridge will
actually run with), then runs
inspectDiscordVoiceReadiness on the live path —
no injected wakeProbe, so a real dormant→engaged
probe runs. PASS/FAIL lines with remediation or
`--json`; exits 1 when not ready.
