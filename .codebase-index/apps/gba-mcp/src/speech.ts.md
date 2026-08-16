# apps/gba-mcp/src/speech.ts

The Discord-reach seams: how a possessor
speaks and hears as Clankie without ever
touching Discord itself. Both are ports the
bridge implements, denied by default with a
reason — a possessor holds no gateway, so
it holds no live presence claim and no
consent registry.

- `ClankieSpeechPort.narrate(text)` — the
  text is an event report, never a script:
  the bridge seeds it into the live
  session and the persona composes the
  words (the method is named for that; it
  used to be `say` and produced the ADR
  0074 defect). `CLANKIE_SPEECH_MAX` = 2000. `deniedSpeechPort` is the default.
- `ClankieHearingPort.subscribe(listener)`
  — push, not pull, as a privacy
  constraint: pull would force the bridge
  to retain transcripts it deliberately
  does not keep. Transcript strings only;
  raw audio never crosses.
- `PossessorHearing` — the possessor-side
  bounded window (`CLANKIE_HEARING_MAX_
LINES` = 50): lazy `start()`, `recent()`
  reads, and `stop()` on release drops
  both subscription and lines, so what was
  heard does not outlive the possession.
