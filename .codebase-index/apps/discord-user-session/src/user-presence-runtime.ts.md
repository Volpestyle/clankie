# apps/discord-user-session/src/user-presence-runtime.ts

`DiscordUserPresenceRuntime` executes transport-neutral presence actions with a bare user token over `fetch`, keeping this body structurally separate from `discord.js` and bot credentials. It supports bounded messages/media, reactions, own-message edits/deletes, typing, threads, music/control and Go Live requests through injected local ports.

Mentions are suppressed on outbound text, attachment refs are hash-resolved, and failures report status/route without echoing Discord bodies. Unsupported activities or absent media/control seams fail closed; `encodeReactionEmoji()` handles REST reaction paths.
