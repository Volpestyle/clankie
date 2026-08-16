# apps/clankie/src/captain/system-authority.ts

`discordTurnHasSystemTools()` is the single authority decision for Discord access to Pi's shell and filesystem tools. Only text turns triggered by a configured `systemActorUserIds` member pass; an empty allowlist, voice lane, or any other lane fails closed.
