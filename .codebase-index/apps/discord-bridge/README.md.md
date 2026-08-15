# apps/discord-bridge/README.md

Operator guide for the official-bot bridge. States
the credential rules (broker only; DISCORD_BOT_TOKEN
/ DISCORD_USER_TOKEN are startup errors), the full
environment reference, and the consent/disclosure
model for voice.

Covers: bounded text ingress (ADR 0024 P2), the
activity plane launched via EMBEDDED_APPLICATION
invites (ADR 0047), two-tier realtime voice with a
mermaid flow diagram (ADR 0057), the ElevenLabs
external voice (ADR 0070), voice join by asking
(ADR 0062), the possessor voice seam on loopback
:4323 (ADR 0064/0067), person-memory commands, and
the readiness / live-proof ceremony commands with
what each gate requires.
