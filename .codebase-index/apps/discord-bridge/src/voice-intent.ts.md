# apps/discord-bridge/src/voice-intent.ts

Asked voice presence (ADR 0062): "clankie hop in
vc" / "you can leave" in an admitted text channel
moves the bot in and out of voice with no slash
command. Injectable, discord.js-free, fully
offline-testable.

Pipeline (handleVoicePresenceAsk): a free
mechanical gate (admitted guild/channel, spoken-to
via mention/name/engaged conversation, a loose
voice-token word — or a wordless message when the
named asker is already in voice, or a pending
retry) → one bounded intent read
(createVoicePresenceIntentDecider, body plus a few
role-attributed context lines, fails closed to
"none", never logged) → deterministic execution
(executeVoicePresenceIntent) under exactly the
slash tier: ADR 0050 authority, voice allowlists,
cross-guild leave bound, target channel always
read from the gateway cache at execution time —
never from model output. Already sitting in the
asked channel is success, never a rejoin (a
rejoin would reset consent).

VoicePresenceRetryWindow: a join refused only for
not_in_voice keeps listening for 120s — the same
asker's follow-up in the same channel ("try
now"), once the gateway shows them in voice,
earns one retry-framed read
(VOICE_PRESENCE_RETRY_SYSTEM_PROMPT). Ids and a
deadline only, max 64 entries, consumed by any
executed decision.

Every evaluation of a message that speaks to him
emits a content-free VoicePresenceAskTrace; the
result is a DiscordVoicePresenceNote injected into
the same captain turn so his reply reflects what
actually happened.
