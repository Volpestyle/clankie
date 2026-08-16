# packages/possessor-voice

The loopback seam that lets a possessor commentate
(ADR 0064). A harness driving Clankie's GBA body
holds no Discord gateway, so it cannot speak; it
reports what the body just did over this seam, and
the process that owns the body in Discord (the
bridge) speaks through the persona.

Children:

- `README.md` — seam rationale, direction, locks
- `package.json` — @clankie/possessor-voice
- `src/` — protocol, listener (bridge side),
  client (possessor side)
- `test/` — client and listener suites
- `tsconfig.json` — standard noEmit config

Shape of the seam:

- Wire is three messages and nothing else:
  `narrate` in; `utterance` (attributed transcript
  or already-admitted text line) and `room` (is
  anyone listening) out. Narration may carry a
  play-journal delivery id that joins later voice
  evidence.
  A possessor cannot join channels or reach any
  presence action from here.
- Narration is context, never a script — the
  bridge seeds it and the persona composes words.
- The possessor dials out; the listener binds
  127.0.0.1 only, gated by a broker-minted
  `clankie_possessor_voice` bearer (second lock).
- Lossy on purpose: `say` refuses when the bridge
  is unreachable rather than queueing; utterances
  with nobody attached are dropped, never
  replayed.
- Listener emits content-free seam evidence
  (connection phase, delivery counts, optional
  stay/journal join ids, sanitized refusal codes)
  for the bridge receipt log.

Client shape structurally matches
`ClankieSpeechPort`/`ClankieHearingPort` in
`@clankie/gba-mcp`, so neither package imports the
other.
