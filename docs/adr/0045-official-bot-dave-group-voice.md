# ADR 0045: Official-bot group voice uses the maintained Discord media stack

Status: accepted (2026-07-25). The STT → captain → TTS pipeline is superseded
by [ADR 0057](0057-realtime-voice-with-captain-handoff.md); media ownership,
DAVE, the consent model, and the allowlists remain authoritative here. Live
Discord evidence remains a deployment gate.

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
  C -->|24 kHz mono PCM<br/>memory only| L[dormant listener<br/>gpt-realtime-whisper]
  L --> F{floor machine}
  F -->|wake| RT[engaged session<br/>gpt-realtime-2.1<br/>ADR 0057]
  M[(approved guild/user memory)] --> B[control-plane briefing] --> RT
  RT -->|ask_clankie| E[Eve discord_voice lane]
  E -->|result text| RT
  RT -->|streamed 24 kHz PCM<br/>AI-voice disclosure| V
  RT --> R[(content-free receipts)]
```

### Consent and privacy

- `DISCORD_VOICE_ENABLED=true` and an explicit **guild** allowlist enable the
  capability. It is off by default.
- `DISCORD_VOICE_CHANNEL_IDS` is optional refinement, not a second gate. Empty
  admits every voice channel inside an allowlisted guild; listing channels
  narrows it further. The guild allowlist is never skipped, so voice reach is
  always bounded to servers the owner chose, and joining still requires the
  voice presence check on `/clankie join` plus per-participant consent.
  `DISCORD_INGRESS_CHANNEL_IDS` follows the same rule, so one mental model
  covers both planes: the guild allowlist bounds reach, the channel list refines
  it. Text ingress has no per-turn gate equivalent to voice consent, so an open
  channel list there makes the ingress trigger policy the only thing standing
  between Clankie and a reply to every message in the server.
- `/clankie join` is gated by the voice presence tier
  ([ADR 0050](0050-voice-presence-authority-tier.md)), joins the invoker's
  allowlisted channel, discloses DAVE, the live OpenAI realtime session's
  audio residency, and AI-generated speech, and opts in only the invoker.
- Every other human uses `/clankie voice-consent opt-in`. Opt-out, leaving the
  channel, bot leave, emergency shutdown, or process restart revokes ephemeral
  consent. Merely being present never implies consent.
- The receiver subscribes only to consented Discord user ids, so unconsented
  audio never reaches the realtime input buffer. Local raw and generated PCM
  buffers are memory-only and zeroed after use; the live realtime session
  retains the call's audio conversation server-side for the duration of the
  call, and the join disclosure says so
  ([ADR 0057](0057-realtime-voice-with-captain-handoff.md)). Voice receipts
  reject transcript, response, prompt, audio, and PCM fields.
- Spoken input remains ambient authority and cannot approve privileged work.
  Approval-shaped results become a generic authenticated-surface handoff.

### Conversation, overlap, and memory

Conversation is answered by the engaged realtime session; anything that
touches the world goes through its single `ask_clankie` tool to the continuing
`discord_voice` Eve lane for the active guild/channel
([ADR 0057](0057-realtime-voice-with-captain-handoff.md)). The control plane,
not the bridge request, resolves approved person-memory facts for consented
guild/user identities and supplies the bounded briefing projection. Voice can
use approved memory but cannot commit memory or persist a raw transcript.

Concurrent speakers retain separate Opus subscriptions. Overlap emits
content-free evidence. Barge-in is deliberate: the floor holder speaking over
him, or a re-address, truncates playback, while crosstalk between other people
lets him finish. Captain handoffs and playback remain serialized so two
responses do not talk over one another.

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
  opened the gateway, so DAVE, consent, per-speaker capture, and the local
  memory-only audio discipline hold identically on both bodies.
