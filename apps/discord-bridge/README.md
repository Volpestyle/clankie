# Discord bridge

The official Discord bot body. It owns bot-shaped concerns: gateway and REST
transport, slash commands, official-bot voice, attachments, and activity
invites. Shared text, presence, consent, memory, voice-floor, and receipt
mechanics live in
[`@clankie/discord-presence-core`](../../packages/discord-presence-core/README.md).

The personal-lab normal-user body is a separate process with a separate
credential and gateway; see
[`apps/discord-user-session`](../discord-user-session/README.md) and
[ADR 0048](../../docs/adr/0048-discord-user-session-transport.md). The
[credential guide](../../docs/credentials.md) distinguishes both Discord account
tokens from Clankie's local bridge bearers.

## Configure

1. Start the clankie service once so it mints the internal bridge bearers.
2. In the TUI, use `/discord` to store the official bot token under provider id
   `discord_bot` and configure the body. Use `/voice` to select OpenAI Realtime
   or Grok Voice, models, voice, reasoning, and the brokered provider API key.
3. Use that flow for application/guild ids, ambient bindings, ingress and
   presence allowlists, voice policy, activity application id, and possessor
   voice enablement. These non-secret settings live in
   `~/.config/clankie/settings.json`.
4. Enable Message Content Intent in the Discord developer portal when bounded
   text ingress is enabled.

Explicit shell values override unset non-secret settings. The main groups are:

| Capability        | Required settings                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| Base bot          | `DISCORD_APPLICATION_ID`; optional development `DISCORD_GUILD_ID`                                |
| Ambient commands  | `DISCORD_AMBIENT_ROLE_IDS` and/or `DISCORD_AMBIENT_USER_IDS`                                     |
| Text ingress      | `DISCORD_TEXT_INGRESS_ENABLED`, `DISCORD_INGRESS_GUILD_IDS`, optional channel/DM policy          |
| Presence writes   | `DISCORD_PRESENCE_GUILD_IDS`, optional channel allowlist                                         |
| Voice             | `DISCORD_VOICE_ENABLED`, `DISCORD_VOICE_GUILD_IDS`, optional channels, join and consent policy   |
| Voice transcripts | Optional `DISCORD_VOICE_TRANSCRIPT_LOGGING_ENABLED`; exact consented text in a private local log |
| Voice provider    | `CLANKIE_VOICE_REALTIME_PROVIDER`; provider model, voice, and optional xAI reasoning effort      |
| Activity          | `DISCORD_ACTIVITY_APPLICATION_ID_GBA`                                                            |
| Possessor voice   | `CLANKIE_POSSESSOR_VOICE_ENABLED`; optional `CLANKIE_POSSESSOR_VOICE_PORT`                       |

Secrets do not belong in that file. `DISCORD_BOT_TOKEN`, `DISCORD_USER_TOKEN`,
and `CLANKIE_CAPTAIN_TOKEN` are hard startup errors. Voice uses the brokered API
credential matching `openai` or `xai`; external speech also uses brokered
`elevenlabs`. Their API-key environment names are rejected by this process when
those paths are active.

The shared voice topology stays the same across providers. OpenAI uses its
realtime transcription session; xAI uses raw-binary streaming STT at `/v1/stt`.
Both feed attributed text into one engaged realtime conversation. Grok defaults
to the pinned `grok-voice-think-fast-2.0` model and `eve` voice; `/voice` can
change both and xAI's `high`/`none` reasoning effort. xAI does not expose a
streaming-STT model selector, so no fake model knob is presented.

`CLANKIE_API_URL` defaults to `http://127.0.0.1:4310`.
`DISCORD_BRIDGE_RECEIPT_PATH` may select an absolute receipt path; otherwise it
uses `${XDG_STATE_HOME:-~/.local/state}/clankie/discord-live-receipts.jsonl`.
When the owner enables full transcript logging in `/discord`, exact consented
final speech from either body is appended to the mode-0600
`${XDG_STATE_HOME:-~/.local/state}/clankie/discord-voice-transcripts.jsonl`.
Receipts remain content-free.

## Start And Verify

Prefer the launcher so service dependencies and health gates are applied:

```bash
clankie restart discord
```

For direct development, start the clankie service first, then:

```bash
pnpm --filter @clankie/discord-bridge start
```

Run readiness before a live ceremony:

```bash
pnpm discord:readiness
pnpm discord:voice-readiness
```

The text checker reads the current process environment plus the broker; when
validating a settings-file deployment, pass the equivalent non-secret settings
as environment overrides. It validates brokered identities, application/guild
membership, Message Content Intent, allowlist alignment, and service
composition. Voice readiness loads stored settings before additionally
validating native Opus, realtime configuration, the voice briefing endpoint,
and a live dormant-to-engaged wake probe. The engaged probe uses the composed
room instructions and fails if a web lookup does not route through
`ask_clankie`. Both support `--json`.

After exercising the relevant surface, evaluate the mode-0600 receipt log with
the package scripts that actually own the gates:

```bash
pnpm --filter @clankie/discord-bridge live-proof
pnpm --filter @clankie/discord-bridge person-memory-live-proof
pnpm --filter @clankie/discord-bridge voice-live-proof
```

Text proof requires a settled admitted message and Discord reply id.
Person-memory proof requires the same fact id after a service restart. Voice
proof requires the full multi-speaker DAVE ceremony encoded by the evaluator.
Fixtures cannot satisfy these live gates.

## Body Behavior

- `/clankie status`, `person-memory`, `join`, `leave`, `voice-consent`,
  `voice-status`, and `watch` are the registered slash subcommands. Voice
  responses and disclosures are ephemeral. The captain's argument-free
  `voice_join` / `voice_leave` tools also reach this process: a Discord turn
  follows the authenticated speaker, an operator-console turn follows the
  configured owner ([ADR 0062](../../docs/adr/0062-voice-join-by-asking.md)).
- Bounded text ingress is deny-by-default by guild/channel/DM policy. Admitted
  Discord content and attachments are labelled untrusted before the captain
  sees them. Text-only input in the active voice channel instead enters that
  room's shared floor, so the realtime persona may answer aloud or stay silent
  without a second text reply ([ADR 0124](../../docs/adr/0124-one-self-has-many-local-threads.md)).
  The bridge persists no channel transcript.
- Presence actions use a live gateway claim and the configured presence
  allowlists. Reactions and thread actions are grounded in the triggering
  message. See [ADR 0024](../../docs/adr/0024-discord-dual-plane-presence.md).
- Official-bot group voice remains on `@discordjs/voice`; it does **not** execute
  the AGPL Vox binary. Shared realtime conversation policy is documented in
  [`@clankie/discord-presence-core`](../../packages/discord-presence-core/README.md)
  and [ADR 0045](../../docs/adr/0045-official-bot-dave-group-voice.md).
- Vox currently owns screen-watch, Go Live, and native media for the separate
  personal-lab user-session body through the Apache
  [`@clankie/vox-client`](../../packages/vox-client/README.md) boundary. See the
  [Vox operating guide](../vox/README.md).
- Bot accounts cannot Go Live. This body launches the supported embedded
  [Discord activity](../discord-activity/README.md) for gameplay viewing.
- YouTube requests are ordinary text/voice prompts, not slash commands. Audible
  playback uses the shared bounded queue through host `yt-dlp`, FFmpeg, and
  `@discordjs/voice`; the bot must already be joined to voice. See the
  [Discord media guide](../../docs/discord-media.md).
- Gameplay commentary and hearing use the canonical
  [`@clankie/possessor-voice`](../../packages/possessor-voice/README.md) seam.
  This README does not duplicate its wire, credential, or loss semantics.

Receipts contain bounded ids, counts, durations, and typed outcomes only. They
exclude message bodies, transcripts, names, media, and credentials.
