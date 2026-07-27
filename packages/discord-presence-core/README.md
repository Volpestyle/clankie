# @clankie/discord-presence-core

Transport-neutral Discord participation. Everything here is blind to whether
Clankie is wearing the official bot or the personal-lab user session, which is
what lets both bodies be one character
([ADR 0024](../../docs/adr/0024-discord-dual-plane-presence.md),
[ADR 0048](../../docs/adr/0048-discord-user-session-transport.md)).

| Module                       | Responsibility                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `presence-session`           | Gateway/voice phase lifecycle, typed phase events, act-tool revoke fence                                      |
| `presence-action-advertiser` | Retains the live catalogue and forwards phase as an execution fence                                           |
| `text-ingress`               | Normalises gateway messages into bounded, policy-gated Eve turns                                              |
| `voice-address`              | Phonetic wake and explicit-release detection over `characterNames()` (ADR 0057)                               |
| `voice-floor`                | The dormant ↔ engaged floor machine: wake, decay, and the volition rate cap                                   |
| `realtime-session`           | Injectable OpenAI Realtime boundary: transcription + conversation sessions, `ask_clankie` round trips         |
| `elevenlabs-tts`             | Injectable ElevenLabs multi-context streaming-TTS boundary (ADR 0070)                                         |
| `external-voice`             | Pairs a text-modality realtime session with a TTS mouth behind the one conversation port (ADR 0070)           |
| `voice-session`              | Media owner: consent, per-speaker capture, the two-tier realtime flow, deliberate barge-in, streamed playback |
| `voice-ingress`              | Routes one `ask_clankie` handoff to the continuing `discord_voice` captain lane                               |
| `voice-consent`              | Ephemeral, session-bound consent — never inferred from presence                                               |
| `voice-audio`                | Memory-only PCM conversion between Discord 48 kHz stereo and realtime 24 kHz mono                             |
| `receipt-store`              | Append-only, content-free receipts for both planes                                                            |

Voice receipts use the `discord.voice.*` vocabulary — `joined`, `consent`,
`utterance`, `floor`, `response`, `volition`, `overlap`, `interrupted`,
`failed`, `left` — and every field is a content-free scalar: ids, counts,
durations, and typed outcomes, never transcript, prompt, audio, or PCM.

## Rules

- **Never import `discord.js`.** A bot-shaped client is a transport detail and
  belongs in the app that owns that transport. The bot bridge uses `discord.js`;
  the user-session bridge uses a bounded raw gateway plus `fetch`.
- **Derive the lane address from `discordPresenceLaneAddress`.** It is keyed by
  where the conversation happens (`discord:<guildId|dm>:<channelId>`), never by
  which transport observed it. A transport-local identifier would fork one
  conversation into two Eve lanes and split the character in half.
- **`transportKind` is configuration, not inference.** Both ingress paths take
  it from their host process; neither guesses.

## Consumers

- `apps/discord-bridge` — official bot: slash commands, mission threads, the
  activity plane.
- `apps/discord-user-session` — personal-lab user session, gated by
  [ADR 0048](../../docs/adr/0048-discord-user-session-transport.md).
