# packages/protocol/test

Vitest suites, one file per contract area of
`src/index.ts`. They pin the boundary properties
(strictness, bounds, frozen tables, refinements)
rather than re-testing zod.

- protocol.test.ts — operator conversations, lane
  compatibility, context/tool detail, governed
  share refs, presence events, public types
- event-stream.test.ts — stream-kind namespaces
  and the DomainEvent envelope
- embodiment.test.ts — intents, session records,
  transitions, lifecycle reports, play notes
- discord-person-memory.test.ts — bounded facts
  and escape-path rejection
- discord-voice-evidence.test.ts — voice receipt
  variants (transcription/tool/music/possessor),
  optional stay/token counters, and free-text
  unrepresentability
