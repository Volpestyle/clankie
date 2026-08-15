# apps/discord-user-session/src/index.ts

The user-session process. Fills shared DISCORD_*
settings, hard-errors on DISCORD_USER_TOKEN /
DISCORD_BOT_TOKEN / CLANKIE_CAPTAIN_TOKEN,
resolves the brokered user-bridge (and voice)
captain bearers, then runs
assertUserSessionAdmissible — a refusal is
recorded as a `discord.user_session.refused`
receipt, not merely thrown — before a single byte
reaches Discord.

Composes a DiscordPresenceSession (transportKind
user_session, session id bound to the opt-in id),
DiscordTextIngress with contextMessageLimit 0
(ambient history stays off this plane; the
account also never answers itself), and an
optional minimal DiscordVoiceSession: the same
realtime transcription/conversation runtimes and
CLANKIE_VOICE_* env parsing as the bot bridge
(duplicated locally in
parseUserSessionVoiceRealtimeEnv — same names,
defaults, and bounds) but deliberately no
volition decider. An inline idle auto-leave
mirrors the bot's.

Exports joinUserSessionVoice — operator-driven,
since a user account has no slash commands —
gated on the guild and voice-channel allowlists.
Receipts go to an absolute out-of-workspace JSONL
path; SIGINT/SIGTERM leave voice, destroy voice
adapters, close the gateway, stop the presence
session, and append a stop receipt.
