# packages/interactive-environment/src/discord-presence.ts

The Discord presence plane (ADR 0024): phases,
session records, the frozen action catalog, and
lane addressing shared by both transports.

- `DiscordPresenceSessionPhaseSchema` — off/
  connecting/present/voice_active/go_live_active/
  degraded/failed.
- `DiscordPresenceSessionRecordSchema` — the
  durable record: transportKind (bot|user_session),
  phase, gatewayConnected, voiceGuildIds, optional
  named `voiceRooms` (must mirror voiceGuildIds
  exactly, sorted), optional `guilds` membership
  with per-guild `channelAccess` (visible/hidden
  channel names, capped with truncation counts),
  `activityInstances` (a facet, not a phase rung —
  instances cannot outlive a connected phase),
  revision. SuperRefines keep phase, gateway, and
  voice state mutually consistent.
- `DiscordPresencePhaseEventSchema` — the
  phase_changed semantic event, refined so event
  identity/phase/timestamp match the embedded
  record. `DiscordVoiceStay`/`DiscordVoiceHistory`
  are the read-side voice-history shapes.
- `DISCORD_PRESENCE_CATALOG` — frozen catalog of
  presence actions with doctrine risk class,
  carrying transports, and minimum phase; Go Live
  is user_session-only, embedded activities are
  bot-only. `isDiscordPresenceActionAvailable`
  gates by transport, phase rank, and the activity
  facet. Unlisted Discord methods fail closed.
- `discordPresenceLaneAddress({guildId?,
channelId})` → `discord:<guildId|dm>:<channelId>`
  — the canonical lane key by _where_ the
  conversation happens, never which transport
  observed it (one character across bodies,
  ADR 0048).
- Tool exposure: v2 lanes with legacy `tui`
  dual-read as `operator`; only the
  `discord_presence` lane gets act tools
  (`resolveDiscordPresence[Phase]ToolExposure`).
- Live-claim headers + schema
  (`DISCORD_PRESENCE_LIVE_*_HEADER`,
  `DiscordPresenceLiveClaimSchema`) for the
  authenticated bridge→service phase fence, and
  phase mappers to/from the shared environment
  lifecycle.
