# docs/adr/0085-a-picture-he-makes-is-something-he-says.md

Decision that an image Clankie generates can travel as part of his own reply without a separate approval flow. The media connector creates and validates artifacts; the service preserves provenance and the presence transport decides how the reply carries them, while slow videos use jobs.
