# packages/discord-presence-core

Transport-neutral Discord participation: text
ingress, presence lifecycle, the whole voice
stack (consent, per-speaker transcription, floor,
realtime, TTS, screen sight, music, playback),
shared loopback controls, and content-free
receipts. Everything is blind to
whether Clankie wears the official bot or the
personal-lab user session — which is what lets
both bodies be one character (ADR 0024/0048).
Consumed by `apps/discord-bridge` and
`apps/discord-user-session`.

Children:

- `README.md` — module table + rules
- `package.json` — @clankie/discord-presence-core
- `src/` — 17 implementation modules plus the
  barrel (see src.md)
- `test/` — 15 suites mirroring the modules
- `tsconfig.json` — standard noEmit config

Hard rules:

- Never imports `discord.js` — a bot-shaped client
  is a transport detail owned by a bridge app
  (`@discordjs/voice` + prism-media for media is
  the one carve-out, in voice-session).
- Lane addresses come from
  `discordPresenceLaneAddress` (keyed by channel,
  never transport), so a body swap continues one
  conversation.
- Attachment policy (`selectInboundImageAttachments`)
  lives here so both bodies admit the same images
  (ADR 0081); the package carries references,
  never fetches bytes.
- Voice receipts (`discord.voice.*`) are
  content-free scalars only — the schema makes
  transcript/audio fields unrepresentable.

Voice architecture (ADR 0057/0070/0099): each
consented speaker gets a separate dormant
transcriber that can answer nothing; a floor
state machine alone decides when the engaged
conversation tier speaks; privileged work goes
through `ask_clankie`, while read-only screen
sight and music remain local tools; an optional
external mouth (text realtime + ElevenLabs TTS)
sits behind the same conversation port.
