# docs/adr/0067-a-play-request-speaks-through-the-possessor-seam.md

Asked play composes the gameplay persona, the
separate Voice agent, and the ADR 0064 possessor
transport in the production play host. The host
reports events and receives room utterances; ADR
0074 makes the realtime session the only author of
audible words.

Read for graceful degradation and ownership: a
missing bridge or rejected line leaves play
running and watchable, room speech enters the same
bounded `InterjectionQueue` as developer stdin,
and the play host gains no Discord gateway or
credential class.
