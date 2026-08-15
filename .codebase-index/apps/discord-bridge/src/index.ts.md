# apps/discord-bridge/src/index.ts

The bridge process. Fills unset DISCORD_* env from
operator settings, hard-errors on any token-shaped
env (DISCORD_BOT_TOKEN, DISCORD_USER_TOKEN,
CLANKIE_CAPTAIN_TOKEN, OPENAI_API_KEY,
ELEVENLABS_API_KEY), resolves every credential
from the broker, then composes and logs in the
discord.js client.

Composes: DiscordPresenceSession publishing typed
gateway phase events (ready/resume/disconnect,
guild membership + per-channel visibility, voice
state with occupants) to the service;
DiscordTextIngress behind allowlists with a
periodic catch-up pass; DiscordVoiceSession with
realtime ports, briefing provider, floor config,
and volition decider from voice-composition;
VoiceIdleAutoLeave; the loopback possessor voice
listener (ADR 0064) wired to narrate/transcript;
and the asked voice-presence path (ADR 0062)
executed before each message's captain turn.

handleCommand dispatches the `/clankie`
subcommands: status (health probe), person-memory
(propose/recall via the service, ambient tier),
join/leave/watch (voice presence tier, guild and
channel allowlists), voice-consent and
voice-status (ungated by design). All voice
replies are ephemeral.

Also here: receipt path resolution (must be
absolute, outside the workspace), recordReceipt /
recordVoiceEvidence (feeding idle auto-leave,
possessor room state, and the per-turn latency
log line), and idempotent SIGINT/SIGTERM
shutdown that leaves voice, closes the listener,
stops the presence session, and appends a stop
receipt.
