# apps/discord-bridge

Clankie's official Discord bot body: slash
commands, bounded text ingress, realtime group
voice, and the activity launch plane. A channel
adapter around `@clankie/discord-presence-core` —
it holds bot-shaped concerns only and never owns
model credentials or a user token.

- README.md — operator guide: config, voice
  architecture, activity plane, proof gates
- package.json — scripts (readiness, live-proof,
  voice variants) and discord.js/voice deps
- src/ — gateway process, command dispatch,
  voice composition, presence runtime, CLIs
- test/ — vitest suites incl. source-asserted
  authority tiers and golden IPC fixtures

Key invariants: every credential (bot token,
captain bearers, OpenAI, ElevenLabs) comes from
the credential broker — the matching env vars are
hard startup errors. Voice needs DAVE plus
per-user consent; the two-tier realtime flow
(dormant whisper listener → engaged gpt-realtime
session, ADR 0057) is composed in
voice-composition.ts and asked-join ("clankie hop
in vc") in voice-intent.ts. Everything emits
content-free JSONL receipts that the
readiness/live-proof CLIs evaluate as evidence
gates. Non-secret DISCORD_* settings fill from
~/.config/clankie/settings.json at startup.
