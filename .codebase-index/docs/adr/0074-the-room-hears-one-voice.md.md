# docs/adr/0074-the-room-hears-one-voice.md

Resolves the two-authors contradiction between
ADR 0064 (persona composes) and ADR 0067 (Voice
agent's sentences sent through the seam): the
realtime session is the sole author of everything
a voice room hears; the play loop reports events
(`narrate`), never sentences.

Read for the three parts: the seam carries only
events, filtered to turns his own volition fired
on (volition says whether, the room says what);
the Voice agent is not consulted while a room
listens (it still authors the overlay and
journal); exactly one author per surface. The
voice briefing must carry a live-embodiment card
or the persona invents context around reports.
