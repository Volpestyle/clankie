# ADR 0045: Official-bot group voice uses the maintained Discord media stack

Status: accepted (2026-07-25). [ADR 0057](0057-realtime-voice-with-captain-handoff.md)
defines the realtime speech path; media ownership, DAVE, the consent model, and
the allowlists remain authoritative here. Live
Discord evidence remains a deployment gate.

## Context

Clankie needs an official Discord bot that can participate in a multi-person
voice channel with speaker attribution, transcription, the same pi captain
identity, governed person memory, and spoken responses. ADR 0025 selected a
selective import of the v1 Rust ClankVox media owner. ADR 0100 records that
source's `AGPL-3.0-or-later` disposition as an isolated native package inside
this otherwise `Apache-2.0` repository.

The maintained `@discordjs/voice@0.19.2` package already owns the official-bot
voice WebSocket, UDP, RTP/Opus, transport encryption, receive subscriptions,
and DAVE session used by the bridge. It is Apache-2.0, exposes each received
speaker as a Discord user id, and defaults DAVE encryption on. A second media
implementation is unnecessary for the bounded group-voice outcome.

## Decision

The official-bot group-voice session lives in `apps/discord-bridge` and has one
media owner: `@discordjs/voice`. This decision supersedes ADR 0025's ClankVox
placement and direct `guild.voiceAdapterCreator` plan for official-bot voice.
The AGPL Vox source now lives in the explicit mixed-license `apps/vox` package
under ADR 0100, but it is not executed for official-bot voice.

![ADR 0045: Official-bot group voice uses the maintained Discord media stack](../diagrams/0045-official-bot-dave-group-voice.jpg)

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
  it. Text has no per-speaker consent gate, so every message in those admitted
  channels reaches the captain by default; he still decides whether to reply.
  The explicit `addressed` resource policy narrows that spend when wanted.
- `/clankie join` is gated by the voice presence tier
  ([ADR 0050](0050-voice-presence-authority-tier.md)), joins the invoker's
  allowlisted channel, discloses DAVE, the live OpenAI realtime session's
  audio residency, and AI-generated speech, and opts in only the invoker.
- Under the default `explicit` policy every other human uses
  `/clankie voice-consent opt-in`. [ADR 0071](0071-presence-as-consent-voice-policy.md)
  also permits an owner-selected `presence` policy for disclosed private rooms;
  explicit opt-out always wins. Leaving the channel, bot leave, emergency
  shutdown, or process restart revokes ephemeral consent.
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
`discord_voice` pi session for the active guild/channel
([ADR 0057](0057-realtime-voice-with-captain-handoff.md)). The Clankie service,
not the bridge request, resolves approved person-memory facts for consented
guild/user identities and supplies the bounded briefing projection. Voice can
use approved memory but cannot commit memory or persist a raw transcript.

Concurrent speakers retain separate Opus subscriptions and separate
transcription sessions, then converge as gateway-attributed text in one shared
floor and engaged conversation. Overlap emits content-free evidence. Barge-in
is deliberate: the floor holder speaking over him, or a re-address, truncates
playback, while crosstalk between other people lets him finish. The utterance's
gateway user id and delivery id remain immutable through captain handoff and
response evidence, even if another participant takes the floor meanwhile.
Captain handoffs and playback remain serialized so two responses do not talk
over one another.

### Credentials and evidence

The official `discord_bot` token and the existing `openai` API key are read
from the credential broker; environment copies are startup errors. The control
plane mints distinct `clankie_discord_bridge` and
`clankie_discord_voice_bridge` bearers. The latter authenticates only the
`discord_voice` captain source.

Readiness checks the brokered identities, OpenAI speech configuration, native
Opus, allowlists, live bot/application/guild identity, and Clankie service
composition. The live gate requires one positive DAVE protocol, three unique
explicit consents, three attributed speakers with captain/TTS round trips, no
media failure, and a clean leave.

## Options weighed

- **Use v1 ClankVox for official-bot voice** — rejected for this outcome because
  the maintained library supplies the required bot media and DAVE paths. Vox
  remains the separately licensed user-session media owner under ADR 0100.
- **Write a new Rust sidecar** — rejected because it duplicates an actively
  maintained protocol implementation without adding a required isolation
  boundary.
- **Normal-user voice or Go Live transport** — rejected for official-bot voice.
  The separately opted-in screen-watch/publish path later shipped in
  [ADR 0098 (user-session shares)](0098-user-session-watches-discord-shares.md)
  and never shares this session.
- **Local temporary-file STT/TTS** — rejected because the existing brokered
  speech provider supports a bounded memory-only path and avoids raw-audio
  filesystem retention.

## Consequences

- `@discordjs/opus` is an approved native build dependency and must load in
  readiness.
- A live Discord server and three consenting humans remain necessary to call
  the group-voice row complete; deterministic tests cannot substitute for it.
- Discord screen watch/publish uses the isolated user-session Vox media owner
  from [ADR 0100](0100-vox-is-an-owned-native-media-package.md). This ADR grants
  no normal-user token capability.
- [ADR 0048](0048-discord-user-session-transport.md) reuses this media owner
  behind the personal-lab user session through a custom gateway adapter. The
  single-media-owner decision constrains the media stack, not which credential
  opened the gateway, so DAVE, consent, per-speaker capture, and the local
  memory-only audio discipline hold identically on both bodies.
