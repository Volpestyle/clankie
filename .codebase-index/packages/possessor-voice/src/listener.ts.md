# packages/possessor-voice/src/listener.ts

`createPossessorVoiceListener` — the gateway-
holding side of the seam, hosted by whichever
process owns the body in Discord (the bot bridge).
An HTTP server that serves nothing (404), upgrades
WebSockets only on `/possessor` with a valid
bearer (timing-safe compare), and binds 127.0.0.1
only.

Behavior:

- Inbound `narrate` messages are schema-checked
  and handed fire-and-forget to the injected
  `narrate(text)` (the live voice session);
  success emits `possessor_narration_submission`
  evidence, rejection emits `possessor_refusal`
  with a sanitized single-token reason — never
  both, and never the text.
- `publishUtterance(text)` broadcasts one
  transcript line to attached possessors; nothing
  is retained or replayed for absent ones.
- `publishRoom(state)` pushes the listening
  boolean on every presence change; a possessor
  attaching mid-call gets the current room state
  immediately via the injected `room()` reader.
- All evidence (`PossessorVoiceListenerEvidence`)
  is content-free: connection phase, attached/
  delivered counts, delivery ids, refusal codes.
- Throws `possessor_voice_token_required` on an
  empty token; 64 KB max payload; `close()` tears
  down sockets and the server.
