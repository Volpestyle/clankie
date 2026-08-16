# packages/possessor-voice/src/protocol.ts

The wire contract for the possessor voice seam
(ADR 0064): three strict zod messages, schema
version 1, and deliberately nothing more.

- `PossessorNarrateSchema` (possessor → bridge):
  bounded `text` describing what just happened in
  the body — context the persona voices, never a
  script (2 000-char cap).
- `PossessorUtteranceSchema` (bridge → possessor):
  one already-attributed transcript line, pushed
  as it happens; push-not-pull so the bridge
  retains no transcripts. Raw audio never crosses.
- `PossessorRoomSchema` (bridge → possessor): a
  single `listening` boolean — whether anyone can
  hear the body — pushed on change and on connect.
  A participant count was drafted and cut.
- Client/server discriminated unions, plus
  `POSSESSOR_VOICE_PATH` ("/possessor"),
  `POSSESSOR_VOICE_DEFAULT_PORT` (4323), and
  `POSSESSOR_VOICE_DEFAULT_URL` (loopback ws URL).
