# docs/adr/0067-asked-play-speaks-through-the-possessor-seam.md

Wired the missing voice half of asked play: the
production play host composes persona + the ADR
0056 Voice agent + the ADR 0064 possessor seam
(what the dev CLI already did), and room speech
feeds the same `InterjectionQueue` stdin did.

Partially superseded by ADR 0074: the outbound
half described here sent finished sentences
through an event-carrying seam — the defect 0074
repairs (events only; the realtime session
authors). The inbound half — attributed
transcripts reaching the play loop as
interjections — is unchanged and still correct.
Read for the degradation rule (silence is a
degraded mode of playing, never a reason not to
play) and the single operator switch
(`possessorVoiceEnabled`).
