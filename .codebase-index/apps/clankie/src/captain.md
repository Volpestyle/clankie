# apps/clankie/src/captain

Clankie's mind on Pi: lane-scoped sessions, persona/instructions, trusted memory recall, authored capabilities, and durable operator conversations. Tool availability is the security boundary: operator turns and allowlisted system-actor text turns may receive Pi system tools; voice and ordinary social turns never do.

- `captain.ts` — session construction, durable steering, hard text deadline, skill translation, tool event detail, Herdr seat injection.
- `port.ts` — `CaptainPort` HTTP seam and test stub.
- `conversations.ts` — file-backed operator registry/event tails with revision fencing and detached runs.
- `discord-turn.ts` — fixed framing for untrusted Discord context, images, memory, and async render notices.
- `tools.ts` — play, sight/share, self-state, Discord social/voice/music, drawing, memory, media, and browser tools.
- `connect-tools.ts` — Linear/email tools with lane-specific authority.
- `system-authority.ts` — allowlisted Discord text system-tool decision.
- `herdr-census.ts`, `herdr-seat.ts`, `herdr-summaries.ts` — live fleet context for seated operator turns.
- `lane-log.ts` — room transcript JSONL plus lane observation.
- `deps.ts` — injected ports available to tools.
- `model.ts` — credential-broker bridge to Pi models.
- `play.ts` — bounded embodiment start/stop orchestration.
- `instructions.md` — identity, leadership, connected-work, drawing, music, and honesty rules.

Operator conversations persist model/tool lifecycle, bounded redacted tool details, context occupancy, and media. Discord text is one-shot unless tool-authorized, voice is durable per room and concurrent speech steers into the active run, and episodic recall refreshes as trusted system context before every run.
