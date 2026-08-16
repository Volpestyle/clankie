# packages/protocol/src/index.ts

The entire zod-only `@clankie/protocol` surface
(~3,460 lines): strict schemas, inferred types,
frozen policy tables, artifact-ref guards, and a
few small runtime helpers for every cross-process
boundary.

Sections, top to bottom:

- **Ids, lanes, observations:** mission/captain
  ids; v1 and v2 lane compatibility; bounded
  lane-entry observation.
- **Operator conversations:** records with
  provider-neutral context usage; bounded stream
  events including tool detail; replay recovery;
  revision-fenced submits with optional herdr
  pane; callable dispatch client.
- **Authority and events:** lane/tier consistency,
  reserved stream namespaces, domain envelopes,
  and captain presence reports.
- **Turn media:** strict SHA-256 refs for generated
  media, browser artifacts, tldraw diagrams, and
  Discord share stills; settled/silent/waiting/
  failed turn results.
- **Discord:** transport-neutral presence actions
  and risk/payload tables, channel turn/write
  contracts, local captain-action inputs, durable
  user-session opt-in, bounded motion-frame
  attachments, voice-presence results, and the
  stream-watch report/read projection.
- **Pairing and embodiment:** device grant fences;
  asked-play intent/session/claim/assignment/
  possession/lifecycle contracts and frozen
  transitions.
- **Memory:** approved Discord-person facts,
  owner edits/export/delete, captain episodes and
  owner edits, and the complete operator-only
  memory catalogue.
- **Browser, media, diagrams:** doctrine-projected
  browser calls; image/video generation; ER and
  sequence diagram requests/results with bounded
  tables, rows, edges, lanes, and steps.
- **Discord voice evidence:** strict content-free
  receipts for capture/transcription, floor,
  model responses, realtime tools, music,
  playback, tokens/stay ids, and possessor
  submission/suppression/refusal.

All public objects are bounded and generally
strict; untrusted free text is deliberately
unrepresentable in evidence records. Frozen
tables keep process policy aligned, while helpers
such as `eventStreamKindForId`, artifact guards,
presence content resolution, and the operator
conversation client live beside their schemas.
