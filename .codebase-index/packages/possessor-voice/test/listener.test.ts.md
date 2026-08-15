# packages/possessor-voice/test/listener.test.ts

Listener suite against a real loopback server and
`ws` clients. Covers: refusing construction with a
blank token; handing narration to the live voice
session with a `possessor_narration_submission`
receipt; rejecting a wrong bearer and unknown
paths at upgrade; surviving narrate failures
without dropping the connection; ignoring
off-contract client messages (e.g. a smuggled
join_channel); pushing utterances only to attached
possessors with nothing retained or replayed; and
emitting only content-free lifecycle/delivery/
refusal evidence — asserted to contain no
transcript or narration text.
