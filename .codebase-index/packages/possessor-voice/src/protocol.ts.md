# packages/possessor-voice/src/protocol.ts

Version-1 wire contract for the ADR 0064
possessor seam: three strict zod messages and no
general presence controls.

- `PossessorNarrateSchema` (possessor → bridge):
  bounded context about what the body did, plus
  an optional whitespace-free `deliveryId` that
  joins play and voice evidence.
- `PossessorUtteranceSchema` (bridge → possessor):
  one already-admitted room line, sourced from
  consented voice transcription or allowlisted
  text. Push-only, so the bridge retains nothing.
- `PossessorRoomSchema` (bridge → possessor): one
  listening boolean, pushed on change/connect.

Raw audio, audiences, identities, join/leave, and
other presence actions are unrepresentable.
Exports the client/server unions and loopback
path/port/URL constants.
