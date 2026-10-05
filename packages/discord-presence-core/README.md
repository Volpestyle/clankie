# @clankie/discord-presence-core

Transport-neutral Discord participation. Everything here is blind to whether
Clankie is wearing the official bot or the personal-lab user session, which is
what lets both bodies be one character
([ADR 0024](../../docs/adr/0024-discord-dual-plane-presence.md),
[ADR 0048](../../docs/adr/0048-discord-user-session-transport.md)).

| Module                       | Responsibility                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `presence-session`           | Gateway/voice phase lifecycle, typed phase events, act-tool revoke fence                              |
| `presence-action-advertiser` | Retains the live catalogue and forwards phase as an execution fence                                   |
| `discord-rest`               | Shared bounded REST writes for both Discord transports                                                |
| `captain-action-control`     | Authenticated local control requests from captain tools                                               |
| `text-ingress`               | Normalises gateway messages into bounded, allowlist-gated captain turns, images included (ADR 0081)   |
| `room-text`                  | Shared admission for typed room experience across text, voice, and game threads (ADR 0124)            |
| `voice-address`              | Phonetic name-mention: opens a session; the offered turn decides whether to speak (ADR 0119)          |
| `voice-floor`                | Dormant ↔ engaged floor: wake, offer (silence-ok), listen, decay, volition (ADR 0119)                 |
| `realtime-session`           | Injectable OpenAI/xAI realtime boundaries: transcription, conversation, and `ask_clankie` round trips |
| `elevenlabs-tts`             | ElevenLabs legacy TTS and explicit v4 Turbo dialogue WebSocket boundary (ADR 0070)                    |
| `external-voice`             | Pairs a text-modality realtime session with a TTS mouth behind the one conversation port (ADR 0070)   |
| `voice-session`              | Vox-backed attributed speech/text input, shared group floor, deliberate barge-in and playback         |
| `voice-composition`          | Shared voice dependency assembly for bot and user-session bodies                                      |
| `voice-control`              | Local join/leave control request handling                                                             |
| `voice-music`                | Shared bounded queue and transport controls                                                           |
| `voice-ingress`              | Routes one `ask_clankie` handoff to the continuing `discord_voice` captain lane                       |
| `voice-consent`              | Ephemeral consent under explicit or owner-selected presence policy; opt-out always wins               |
| `voice-audio`                | Shared voice-provider PCM helpers and content-free RMS measurement                                    |
| `receipt-store`              | Append-only, content-free receipts for both planes                                                    |

Voice receipts use the `discord.voice.*` vocabulary — `joined`, `consent`,
`utterance`, `text_input`, `floor`, `response`, `volition`, `overlap`, `interrupted`,
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
  their raw attachments and link-preview images (including `gifv` embeds) and call `selectInboundImageAttachments`, so one
  rule decides what he can be shown. A policy that admitted an image on one
  body and not the other would be two characters, not one
  ([ADR 0081](../../docs/adr/0081-an-image-is-part-of-what-is-said.md)).
- **This package never fetches attachment bytes.** It carries references; the
  clankie service resolves them at the last hop before the model.
- **The active voice room owns its attached text chat.** Text-only messages in
  that exact guild/channel enter `VoiceFloor`, where the realtime room persona
  speaks, hands off, or stays silent. The bridge does not also launch a text
  captain turn ([ADR 0124](../../docs/adr/0124-one-self-has-many-local-threads.md)).
- **Voice identity stays attached to a gateway stream.** Speakers use separate
  transcription inputs. Only attributed JSON transcript items converge into
  the shared engaged conversation; overlapping raw audio is never interleaved
  and guessed after the fact. Every finalized consented speech transcript gets
  a contextual model decision, including nameless requests after a pause. The
  model may stay silent; engagement controls interruption eligibility, not hearing
  ([ADR 0119](../../docs/adr/0119-the-room-is-heard-the-floor-is-who-he-answers.md)).
- **Speaker listeners are bounded.** An inactive per-speaker transcription
  session closes after two minutes and reopens on demand. At 25 retained
  listeners, the least recently active idle listener is evicted before another
  opens; active captures and pending transcript correlation are never evicted.
- **Vox is the sole voice media owner.** Both media-enabled Discord bodies use
  native Vox capture, TTS playback, DAVE readiness, and audible music; a
  text-only bot does not spawn it. This package owns policy and correlation
  only; ordinary leave clears Vox's primary role without closing the process or
  touching its stream-watch/publish roles. TTS is audible only after Vox reports
  `started`; `buffered` means queued and does not occupy the floor, while
  `drained` means finished PCM and trailing frames crossed the sender. Fresh
  app-level readiness evidence records `mediaOwner: vox`; the joined receipt
  separately proves positive role-scoped DAVE. A leave qualifies only after the
  account gateway confirms detachment. See
  [ADR 0128](../../docs/adr/0128-vox-is-the-sole-discord-media-owner.md).

## Consumers

- [`apps/discord-bridge`](../../apps/discord-bridge/README.md) — official bot:
  slash commands, voice, and the activity plane.
- [`apps/discord-user-session`](../../apps/discord-user-session/README.md) —
  personal-lab user session, gated by
  [ADR 0048](../../docs/adr/0048-discord-user-session-transport.md).

### Voice latency evidence

Voice capture commits after 500ms without input audio. Transcription streams
before that boundary, but replies wait for a final transcript. Captures that
never reach 80 RMS (s16 full scale 32,768) are marked `filtered` and send no
provider audio or commit; a bounded 200ms lead-in preserves quiet word onsets
when speech arrives. This near-silence filter is separate from the unchanged
1,200 RMS, transcript-confirmed interruption guard.

`transcription.latencyMs` includes speaking time; `captureEndToFinalMs` measures
finalization and `lastAudioToFinalMs` also includes endpoint delay. Response
receipts retain input timing through wake and tool handoffs:
`lastAudioToFirstAudioMs`, `captureEndToFirstAudioMs`,
`transcriptToFirstAudioMs`, and `transcriptToRequestMs`. The existing
`toFirstAudioMs` starts at the individual response request. External voice
also reports `requestToFirstTextMs`; `requestToFirstAudioChunkMs` and
`firstAudioChunkToPlaybackMs` distinguish synthesis delivery from playback.
Missing measurements are omitted, not zero. Input PCM arrival and transmitted
playback are transport evidence, not measurements of phoneme or headphone time.

Voice receipts allow up to 32 scalar, content-free fields so correlation IDs,
token counts, and timings survive together. Older 16-field writers could lose
response receipts even when Vox logged a successful start and drain.

### Chaotic group calls

Voice ingress keeps different speakers' asks in separate handoffs, one active
speaker per room. The active speaker's refinements can steer their live run;
other speakers wait for their own answer. The realtime conversation and local
voice tools keep running while that work waits. Tool results carry their
recipient, and the mouth gives that person the gist, expanding when warranted. Responses serialize through
provider completion and, for external voices, TTS drain.

A realtime server error can abandon the current local response attempt as failed,
without fabricating provider completion or usage. An unidentified bare error does
not establish which provider response caused it. Abandonment stops that attempt's
partial playback, and the next eligible offer can proceed; failed lines are never
replayed. Uncertain errors before `response.created`, and uncorrelatable ID-less
xAI output after abandonment, close the existing conversation. The next eligible
offer uses the normal lazy reopen path. Correlated delayed response events cannot
settle a newer offer. Live provider compatibility remains unproven.

The floor retains up to five recently engaged speakers for 60 seconds each.
Their unnamed follow-ups are offers Clankie may decline; unrelated chatter is
offered for contextual judgment without forcing a response. Typed-input
volition caps, consent, and machine grants are unchanged. See ADRs [0091](../../docs/adr/0091-a-mid-turn-message-steers-the-turn.md)
and [0119](../../docs/adr/0119-the-room-is-heard-the-floor-is-who-he-answers.md).

Voice playback paces synthesized PCM in 100ms chunks with at most one second
of real-time lead before sending it to Vox. Provider completion waits for the
local queue to empty before `finish_tts_playback`; stop, failure, leave, and
timeout discard queued audio. Vox retains its fail-closed 15-second buffer cap.

New speech replaces unheard replies across the room: bursts during opening
collapse to one opportunity, provider/TTS queues drop stale response requests,
and queued PCM is discarded before playback. A superseded or interrupted reply
still generating gets `response.cancel`, and the external mouth closes its TTS
context and releases its held done, so the next reply never waits on dead speech.
Tool results stay in context; in-flight work retains its actor. Explicit “stop
talking” cuts playback on the final transcript even below the ordinary barge-in
loudness gate; from a recently engaged or addressing speaker it also drops queued
speech and keeps late handoff results silent. A
recently engaged speaker who talks over him for 700 ms of speech-level audio,
in a capture begun after his reply became audible, stops him without waiting
for the transcript (ADR 0057, 2026-10-04). Unaddressed speech waits for a
pause before it becomes a response opportunity: while another participant is
still talking or their final is due, the latest such line waits (bounded at
8 seconds) and is offered once when the room pauses.

Repeated identical asks from the same person join pending work. For paraphrases,
`ask_clankie.join_call_id` joins only that authenticated speaker's handoff;
changed requests remain refinements. Slow work offers one brief acknowledgment
after 1.2 seconds, canceled if the room moves on or work finishes. Voice matches
the length to the moment: most turns are short, while stories, strong opinions,
invested bits, and fuller answers have room. Handoff results follow the same
proportion, with details available in text: at most 1,500 characters of a
captain answer reach the voice model, and an answer arriving 30 seconds or more
late, after the room moved on, is offered rather than forced. Spoken YouTube
searches list three hits for him to name one or two. OpenAI output is bounded to 4096
audio / 1024 text tokens per response, and all Discord mouths have a 45-second
PCM ceiling. These runaway backstops leave room for deliberate 20–30 second
riffs; live taste and transcription latency still require a call.

Opt-in voice transcripts include Clankie's generated wording from native audio
transcripts or external TTS text, correlated with item/playback ids and outcomes.
`subscribeSpokenTranscript` is separate from the consented human listener, so
output cannot masquerade as room input. Without a subscriber the session does
not accumulate output text. Interrupted/failed/truncated entries may include an
unheard ending; suppressed entries never played. The private transcript store
and authenticated API retain these labels; content-free receipts never carry text.

Transcript readers incrementally index newline offsets and read only the requested
page. Existing line-number cursors stay valid; an unfinished tail waits for its newline.
File replacement or truncation rebuilds the index. Receipt writers combine concurrent
appends into batches of at most 64 records; each promise resolves only after the batch
is flushed to disk. The pending queue is bounded at 1,024 records and rejects overload.
