# apps/clankie/src/captain/discord-turn.ts

`normalizeDiscordTurn()` turns one authenticated Discord text/voice delivery into fixed trusted framing plus labelled untrusted content. It resolves trigger and newest-context visuals at the last hop, preserves source/message identity, adds approved person memory and room-scoped completed-render notices, and reports unreadable attachments without guessing.

Voice keeps a durable session per channel; text is one-shot per delivery context. The normalized result includes host-stamped actor/guild/channel/message fields for downstream tools, while `heard` contains only the speaker's words for lane logging.
