# docs/adr/0045-official-bot-dave-group-voice.md

Official-bot group voice: `@discordjs/voice` is
the single media owner (DAVE on, per-speaker Opus
receive), living in `apps/discord-bridge`.
Supersedes ADR 0025's ClankVox plan; its own
STT→captain→TTS pipeline is in turn superseded by
ADR 0057.

Still authoritative for: the consent model —
off-by-default, guild allowlist bounds reach and
the channel list only refines it, per-participant
opt-in, presence never implies consent (relaxed
per-deployment by ADR 0071); brokered credentials
(env tokens are startup errors); and the live
deployment gate (real DAVE session, three
consents, clean leave).
