# apps/clankie/test/play-voice.test.ts

The play-voice wiring per ADR 0067 as amended by
ADR 0074, with a fake possessor-voice client.
The seam itself is proven in
`@clankie/possessor-voice`; what is asserted
here — deliberately inverted from the old
expectations — is that what crosses is what
happened, never a sentence to say: effect lines
(with the goal named) reported only on
speak-wanted turns, silence on the turns
volition passed over, room utterances feeding
the interjection queue (including through the
production loopback seam), the authored voice
agent not consulted while a room is listening
but still used when nobody is, play continuing
when the bridge rejects reports, silent play
when the seam was never bootstrapped, and the
room released when the playthrough ends.
