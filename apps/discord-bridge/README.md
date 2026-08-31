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
   presence allowlists, voice policy, activity application id, and play
   voice enablement. These non-secret settings live in
   `~/.config/clankie/settings.json`.
4. Enable Message Content Intent in the Discord developer portal when bounded
   text ingress is enabled.
5. Build Vox with `pnpm --filter @clankie/vox build`, or point
   `CLANKIE_VOX_BIN` at the owned executable.

Explicit shell values override unset non-secret settings. The main groups are:

| Capability        | Required settings                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Base bot          | `DISCORD_APPLICATION_ID`; optional development `DISCORD_GUILD_ID`                                                          |
| Ambient commands  | `DISCORD_AMBIENT_ROLE_IDS` and/or `DISCORD_AMBIENT_USER_IDS`                                                               |
| Text ingress      | `DISCORD_TEXT_INGRESS_ENABLED`, `DISCORD_INGRESS_GUILD_IDS`, optional channel/DM policy                                    |
| Presence writes   | `DISCORD_PRESENCE_GUILD_IDS`, optional channel allowlist                                                                   |
| Voice             | `DISCORD_VOICE_ENABLED`, `DISCORD_VOICE_GUILD_IDS`, optional channels, join and consent policy; optional `CLANKIE_VOX_BIN` |
| Voice transcripts | Optional `DISCORD_VOICE_TRANSCRIPT_LOGGING_ENABLED`; exact consented text in a private local log                           |
| Voice provider    | `CLANKIE_VOICE_REALTIME_PROVIDER`; provider model, voice, and optional xAI reasoning effort                                |
| Activity          | `DISCORD_ACTIVITY_APPLICATION_ID_GBA`                                                                                      |
| Play voice        | Fixed loopback listener at `ws://127.0.0.1:4323/play` whenever this active body has a voice session                        |

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

For direct development, start the clankie service first and keep
`DISCORD_ACTIVE_BODY=bot`, then:

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
membership, Message Content Intent, text ingress/presence allowlist alignment,
service composition, and whether the bot holds `Manage Channels`,
`Manage Webhooks`, and `Send Messages` in the swarm home
(`DISCORD_SWARM_GUILD_ID`) — the permissions room provisioning needs, so an
otherwise healthy install fails only when a room is first projected. A
guild-wide grant can still be denied on one room by that channel's permission
overwrites. Voice readiness separately loads stored settings and
validates voice credentials and allowlists, Vox binary resolution, a bounded
`process_ready` smoke whose protocol version exactly matches the client,
realtime configuration, the voice briefing endpoint, and a live
dormant-to-engaged wake probe. The engaged probe uses the composed room
instructions and fails if a web lookup does not route through `ask_clankie`.
Process readiness only proves the owned child is running; voice transport and
role-scoped positive DAVE readiness are separate join gates proven by the
session and live ceremony. Fresh media-enabled bridge evidence records
`mediaOwner: vox` and `voxProcessReady: true`; the live proof rejects older
pre-migration readiness. With voice disabled, the text-only bridge records
`mediaOwner: none` and does not spawn Vox. Both checkers support `--json`.

After exercising the relevant surface, evaluate the mode-0600 receipt log with
the package scripts that actually own the gates:

```bash
pnpm --filter @clankie/discord-bridge live-proof
pnpm --filter @clankie/discord-bridge person-memory-live-proof
pnpm --filter @clankie/discord-bridge voice-live-proof
```

Text proof requires a settled admitted message and Discord reply id.
Person-memory proof requires the same fact id after a service restart. Voice
proof requires the full multi-speaker DAVE ceremony encoded by the evaluator,
including one positive role-scoped DAVE protocol and a Vox-owned leave that the
Discord gateway confirms (`gatewayConfirmed: true`), followed by rejoin/leave,
plus a fresh Vox-owner readiness receipt. Process inspection must also show the
one app-lifetime child and no competing Node media owner. Fixtures cannot
satisfy these live gates.

## Body Behavior

- `/clankie status`, `tools`, `person-memory`, `join`, `leave`, `voice-consent`,
  `voice-status`, and `watch` are the registered slash subcommands. Voice
  responses and disclosures are ephemeral. The captain's argument-free
  `voice_join` / `voice_leave` tools also reach this process: a Discord turn
  follows the authenticated speaker, an operator-console turn follows the
  configured owner ([ADR 0062](../../docs/adr/0062-voice-join-by-asking.md)).
- `/clankie tools mode:on|off|status` is owner-only and persists one quiet,
  edited tool-activity card per requested turn in the current guild channel.
  The card contains public-safe categories and counts, never tool arguments or
  results ([ADR 0134](../../docs/adr/0134-discord-tool-work-is-a-status-card.md)).
- Bounded text ingress is deny-by-default by guild/channel/DM policy. Admitted
  Discord content and attachments are labelled untrusted before the captain
  sees them. Text-only input in the active voice channel instead enters that
  room's shared floor, so the realtime persona may answer aloud or stay silent
  without a second text reply ([ADR 0124](../../docs/adr/0124-one-self-has-many-local-threads.md)).
  The bridge persists no channel transcript.
- Presence actions use a live gateway claim and the configured presence
  allowlists. Reactions and thread actions are grounded in the triggering
  message. See [ADR 0024](../../docs/adr/0024-discord-dual-plane-presence.md).
- Media-enabled official-bot group voice owns one app-lifetime Vox child;
  text-only official-bot mode owns none. `discord.js` keeps the bot token and
  gateway; its guild adapter only carries validated OP4 joins and leaves plus
  voice server/state updates. Vox alone owns transport, DAVE, Opus, capture, TTS
  playback, and audible music. Shared realtime conversation policy is documented
  in
  [`@clankie/discord-presence-core`](../../packages/discord-presence-core/README.md)
  and [ADR 0128](../../docs/adr/0128-vox-is-the-sole-discord-media-owner.md).
- The Apache process boundary is
  [`@clankie/vox-client`](../../packages/vox-client/README.md). See the
  [Vox operating guide](../vox/README.md).
- Bot accounts cannot Go Live. This body launches the supported embedded
  [Discord activity](../discord-activity/README.md) for gameplay viewing. Screen
  watch and Go Live stay in the user body because Discord does not expose those
  capabilities to bots, not because another media implementation is retained.
- YouTube requests are ordinary text/voice prompts, not slash commands. Audible
  playback uses the shared bounded queue and Vox's native music path; the bot
  must already be joined to voice. See the
  [Discord media guide](../../docs/discord-media.md).
- Gameplay commentary and hearing use the canonical
  [`@clankie/play-voice`](../../packages/play-voice/README.md) seam.
  It accepts only Clankie's own local or hosted play client; GBA MCP and external
  harnesses have no credential or room-input path. This README does not
  duplicate its wire, credential, or loss semantics.

Receipts contain bounded ids, counts, durations, and typed outcomes only. They
exclude message bodies, transcripts, names, media, and credentials.
