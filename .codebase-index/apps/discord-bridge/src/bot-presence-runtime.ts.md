# apps/discord-bridge/src/bot-presence-runtime.ts

Executes policy-approved Discord presence writes through the official bot REST client. It handles replies, reactions, threads, typing, and Activity operations, and re-exports the shared `encodeReactionEmoji` helper so both Discord bodies validate reaction paths identically.
