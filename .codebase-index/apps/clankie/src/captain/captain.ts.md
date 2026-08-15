# apps/clankie/src/captain/captain.ts

`createCaptain(deps, options)` — the pi-based
captain behind `CaptainPort`. Sessions are pi's:
durable JSONL session trees for operator
conversations and voice channels, one-shot
in-memory sessions for bounded Discord text
turns (the channel history arrives with each
request). Persona comes from owner-authored
settings, never the caller.

Details:

- System prompt = `instructions.md` + the
  persona register mapped per lane
  (operator/social/gameplay).
- Sessions built via pi's
  `DefaultResourceLoader` + `createAgentSession`
  at the repo root with `.agents/skills`
  discoverable; non-operator lanes pass
  `noTools: "builtin"` so untrusted lanes never
  get read/bash/edit/write.
- Tools = `captainTools()` + live
  `browserTools()`; a `TurnMediaCapture` rides
  each session so the last attachable artifact
  of a turn becomes the reply's media.
- One turn at a time per durable session
  (`turnChains`) so overlapping voice messages
  queue instead of cross-wiring capture state.
- A reply equal to the silent sentinel (whole
  trimmed message, never substring) settles as
  `silent`; empty replies fail
  `captain_response_missing`.
- Every heard/said pair lands in the `LaneLog`;
  operator turns stream tool start/end events
  through the conversation publisher.
- `voiceLaneInstructions()` supplies the voice
  briefing's lane fragment; `close()` waits for
  in-flight runs and disposes sessions.
