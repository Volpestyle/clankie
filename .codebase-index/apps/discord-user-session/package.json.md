# apps/discord-user-session/package.json

Private workspace package
`@clankie/discord-user-session`. tsx-run; scripts:
dev/start, `readiness`, typecheck, vitest.

Uses raw `ws` plus discord-api-types instead of
discord.js (which refuses user tokens), alongside
the shared workspace packages, @discordjs/voice +
opus for media, and zod. The GPL Go Live stack is
deliberately absent.
