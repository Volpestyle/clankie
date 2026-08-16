# apps/clankie/src/captain/discord-turn.ts

`normalizeDiscordTurn()`: one untrusted Discord
text/voice message becomes a fenced prompt. The
framing is fixed text — untrusted bodies are
labelled, never allowed to author the
instructions around them — and silence is
offered every turn via the sentinel.

The prompt assembles: the fixed framing (context
guidance for wake-style triggers, addressed vs
unprompted, image handling, unreadable
attachment counts), an optional voice-presence
note (joined/left/refused, with typed refusal
phrases), approved person-memory (voice turns in
guilds only), the untrusted channel context, and
the trigger block.

Session routing: voice turns continue a durable
session per channel
(`discord-voice:<char>:<guild>:<channel>`);
text turns are one-shot keyed by presence
session. Attachments resolve at the last hop and
failures are never fatal — a missing image costs
the picture, not the conversation. `heard`
carries the sender's words for the lane log.
