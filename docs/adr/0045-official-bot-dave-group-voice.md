# ADR 0045: Official-bot group voice uses the maintained Discord media stack

Status: accepted (2026-07-25). The official-bot implementation is present;
live Discord evidence remains a deployment gate.

## Context

Clankie needs an official Discord bot that can participate in a multi-person
voice channel with speaker attribution, transcription, the same Eve captain
identity, governed person memory, and spoken responses. ADR 0025 selected a
selective import of the v1 Rust ClankVox media owner. That import cannot proceed
while its `AGPL-3.0-or-later` source and this repository's `Apache-2.0` license
have no recorded disposition.

The maintained `@discordjs/voice@0.19.2` package already owns the official-bot
voice WebSocket, UDP, RTP/Opus, transport encryption, receive subscriptions,
and DAVE session used by the bridge. It is Apache-2.0, exposes each received
speaker as a Discord user id, and defaults DAVE encryption on. A second media
implementation is unnecessary for the bounded group-voice outcome.

## Decision

The official-bot group-voice session lives in `apps/discord-bridge` and has one
media owner: `@discordjs/voice`. This decision supersedes ADR 0025's ClankVox
placement and direct `guild.voiceAdapterCreator` plan for official-bot voice.
The schema-1 ClankVox IPC parser and fixtures remain an inactive compatibility
artifact; no AGPL ClankVox source is imported or executed.

```mermaid
flowchart LR
  D[Discord group voice<br/>DAVE · RTP/Opus] <--> V[@discordjs/voice<br/>single media owner]
  V -->|consented user-id Opus| C[bounded per-speaker capture]
  C -->|16 kHz mono WAV<br/>memory only| STT[brokered OpenAI STT]
  STT --> E[Eve discord_voice lane]
  M[(approved guild/user memory)] --> E
  E --> TTS[brokered OpenAI TTS<br/>AI-voice disclosure]
  TTS -->|24 kHz mono PCM<br/>memory only| V
  E --> R[(content-free receipts)]
```

### Consent and privacy

- `DISCORD_VOICE_ENABLED=true` and an explicit **guild** allowlist enable the
  capability. It is off by default.
- `DISCORD_VOICE_CHANNEL_IDS` is optional refinement, not a second gate. Empty
  admits every voice channel inside an allowlisted guild; listing channels
  narrows it further. The guild allowlist is never skipped, so voice reach is
  always bounded to servers the owner chose, and joining still requires the
  ambient role check on `/captain-join` plus per-participant consent. Text
  ingress does not share this default: an empty channel list there admits
  nothing, because ingress has no equivalent per-turn gate.
- `/captain-join` is role-gated, joins the invoker's allowlisted channel,
  discloses DAVE, OpenAI transcription, AI-generated speech, and raw-audio
  handling, and opts in only the invoker.
- Every other human uses `/captain-voice-consent opt-in`. Opt-out, leaving the
  channel, bot leave, emergency shutdown, or process restart revokes ephemeral
  consent. Merely being present never implies consent.
- The receiver subscribes only to consented Discord user ids. Each utterance is
  capped at 30 seconds; raw PCM, generated PCM, and the WAV request buffer are
  memory-only and zeroed after use. Voice receipts reject transcript, response,
  prompt, audio, and PCM fields.
- Spoken input remains ambient authority and cannot approve privileged work.
  Approval-shaped results become a generic authenticated-surface handoff.

### Conversation, overlap, and memory

Per-speaker Discord ids address turns to a continuing `discord_voice` Eve lane
for the active guild/channel. The control plane, not the bridge request,
retrieves approved person-memory facts for that guild/user/channel and supplies
the bounded projection to Eve. Voice can use approved memory but cannot commit
memory or persist a raw transcript.

Concurrent speakers retain separate Opus subscriptions. Overlap emits
content-free evidence. A newly consented speaker interrupts synthesis or
playback (barge-in), and the stale response generation is discarded. Captain
turns and playback remain serialized so two responses do not talk over one
another.

### Credentials and evidence

The official `discord_bot` token and the existing `openai` API key are read
from the credential broker; environment copies are startup errors. The control
plane mints distinct `clankie_discord_bridge` and
`clankie_discord_voice_bridge` bearers. The latter authenticates only the
`discord_voice` captain source.

Readiness checks the brokered identities, OpenAI speech configuration, native
Opus, allowlists, live bot/application/guild identity, and control-plane
composition. The live gate requires one positive DAVE protocol, three unique
explicit consents, three attributed speakers with captain/TTS round trips, no
media failure, and a clean leave.

## Options weighed

- **Import v1 ClankVox** — rejected for this outcome because licensing is
  unresolved and the maintained library now supplies the required bot media
  and DAVE paths.
- **Write a new Rust sidecar** — rejected because it duplicates an actively
  maintained protocol implementation without adding a required isolation
  boundary.
- **Normal-user voice or Go Live transport** — rejected for official-bot voice.
  Screen watch/publish remains the separately opted-in personal-lab decision in
  ADR 0024 and never shares this session.
- **Local temporary-file STT/TTS** — rejected because the existing brokered
  speech provider supports a bounded memory-only path and avoids raw-audio
  filesystem retention.

## Consequences

- `@discordjs/opus` is an approved native build dependency and must load in
  readiness.
- A live Discord server and three consenting humans remain necessary to call
  the group-voice row complete; deterministic tests cannot substitute for it.
- Discord screen watch/publish still needs its isolated user-session media
  owner. This ADR grants no normal-user token capability.
- [ADR 0048](0048-discord-user-session-transport.md) reuses this media owner
  behind the personal-lab user session through a custom gateway adapter. The
  single-media-owner decision constrains the media stack, not which credential
  opened the gateway, so DAVE, consent, per-speaker capture, and memory-only
  audio hold identically on both bodies.
