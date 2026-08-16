# apps/discord-user-session/src

The user-session process and its transport pieces.

- index.ts — the process: guards, admission,
  presence session, ingress, minimal realtime
  voice, shutdown
- gateway.ts — hand-rolled minimal Discord
  gateway client for a user token
- voice-adapter.ts — bridges that gateway to
  @discordjs/voice
- readiness.ts — the fail-closed admission gates
  (enablement, allowlists, opt-in, credential)
- readiness-cli.ts — diagnose a refusal without
  connecting
- user-presence-runtime.ts — fetch-based executor
  for the presence action catalog, incl. Go Live
- presence-runtime-module.ts — trusted service
  load target issuing per-action grants
- go-live-media.ts — dynamic loader/publisher for
  the optional GPL selfbot stream stack

Flow: admission passes → the gateway identifies
with the bare brokered token → dispatches feed
DiscordTextIngress (context limit 0 — a user
account reads no channel history) and the voice
session; the service executes allowed presence
writes back through user-presence-runtime over
plain fetch. Voice reuses the same
realtime-session runtimes as the bot but with no
volition decider: a secondary presence never
interjects on its own.
