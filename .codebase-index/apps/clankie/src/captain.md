# apps/clankie/src/captain

The captain on pi: Clankie's mind as pi agent
sessions with an authored tool bank, one persona
across lanes, and durable lane transcripts. The
app layer parses and authenticates; this
directory owns sessions, tools, and persona.

- `port.ts` — `CaptainPort`, the seam the HTTP
  app calls; `createStubCaptain` for tests.
- `captain.ts` — `createCaptain()`: pi sessions
  per lane, turn serialization, silent-reply
  sentinel, operator conversations.
- `conversations.ts` — file-backed operator
  conversation store (meta.json +
  events.jsonl, revision fencing, cursors).
- `discord-turn.ts` — normalizes an untrusted
  Discord turn into a fenced prompt.
- `tools.ts` — the authored tool bank plus
  live-catalog browser tools.
- `play.ts` — start/stop play via embodiment
  intents with a bounded honest wait.
- `model.ts` — bridges the Keychain credential
  broker into pi's model runtime.
- `lane-log.ts` — JSONL heard/said log per
  room; feeds `observe_room` and the TUI.
- `deps.ts` — `CaptainDeps`, everything tools
  reach in the rest of the service.
- `instructions.md` — the identity system
  prompt.

Trust model: operator lanes get pi's built-in
coding tools; lanes fed by untrusted Discord
input get only the authored bank — a tools list
is a boundary, a prompt is not. Untrusted bodies
are labelled and fenced, never allowed to author
the instructions around them, and silence (the
sentinel) is offered on every turn.
