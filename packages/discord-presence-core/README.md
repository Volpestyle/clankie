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
| `text-ingress`               | Normalises gateway messages into bounded, allowlist-gated captain turns, images included (ADR 0081)           |
| `voice-address`              | Phonetic address detection over `characterNames()` (ADR 0057)                                                 |
| `voice-floor`                | The dormant ↔ engaged floor machine: wake, decay, and the unprompted-turn rate cap                            |
| `realtime-session`           | Injectable OpenAI Realtime boundary: transcription + conversation sessions, `ask_clankie` round trips         |
| `elevenlabs-tts`             | Injectable ElevenLabs multi-context streaming-TTS boundary (ADR 0070)                                         |
| `external-voice`             | Pairs a text-modality realtime session with a TTS mouth behind the one conversation port (ADR 0070)           |
| `voice-session`              | Media owner: consent, per-speaker capture/transcription, shared group floor, deliberate barge-in and playback |
| `voice-ingress`              | Routes one `ask_clankie` handoff to the continuing `discord_voice` captain lane                               |
| `voice-consent`              | Ephemeral consent under explicit or owner-selected presence policy; opt-out always wins                       |
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
  conversation into two captain lanes and split the character in half.
- **`transportKind` is configuration, not inference.** Both ingress paths take
  it from their host process; neither guesses.
- **Visuals are selected here, never in a bridge.** Both transports map
  their raw attachment and `gifv` embed shapes and call `selectInboundImageAttachments`, so one
  rule decides what he can be shown. A policy that admitted an image on one
  body and not the other would be two characters, not one
  ([ADR 0081](../../docs/adr/0081-an-image-is-part-of-what-is-said.md)).
- **This package never fetches attachment bytes.** It carries references; the
  clankie service resolves them at the last hop before the model.
- **Voice identity stays attached to a gateway stream.** Speakers use separate
  transcription inputs. Only attributed JSON transcript items converge into
  the shared engaged conversation; overlapping raw audio is never interleaved
  and guessed after the fact.
- **Speaker listeners are bounded.** An inactive per-speaker transcription
  session closes after two minutes and reopens on demand. At 25 retained
  listeners, the least recently active idle listener is evicted before another
  opens; active captures and pending transcript correlation are never evicted.

## Consumers

- `apps/discord-bridge` — official bot: slash commands, voice, the
  activity plane.
- `apps/discord-user-session` — personal-lab user session, gated by
  [ADR 0048](../../docs/adr/0048-discord-user-session-transport.md).
