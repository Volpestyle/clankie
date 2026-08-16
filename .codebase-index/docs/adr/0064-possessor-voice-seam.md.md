# docs/adr/0064-possessor-voice-seam.md

How a possessor gets heard: it never speaks
directly (no gateway, no live presence claim).
It reports events over a loopback listener
(127.0.0.1, brokered `clankie_possessor_voice`
bearer) to the bridge, which seeds the realtime
session — the persona composes the words, never
verbatim.

Read for the four properties: event in, persona
out; loopback + brokered bearer; a two-message
wire (`narrate` in, `utterance` out — no channel
choice, no other actions); hearing is push-only
so bridge retention stays zero. Narration
responses are rate-limited (~12s); seeding is
not. The seam is deliberately unusable as
text-to-speech.
