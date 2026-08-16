# packages/protocol/src/index.ts

The entire `@clankie/protocol` surface (~2900
lines): zod schemas, inferred types, frozen
constant tables, and a few runtime helpers for
every wire boundary in the system. Zod-only; no
Node APIs beyond the language.

Sections, top to bottom:

- Ids and lanes — `MissionIdSchema` and friends;
  `CaptainLaneSchema` (frozen v1: tui /
  discord_voice / gameplay),
  `CaptainSessionLaneV2Schema` (operator /
  discord_voice / discord_presence / gameplay),
  and the transitional compatibility union.
- Captain lane observation (ADR 0083) — read-only
  session→lane listing (`ObservableCaptainLane`,
  `CaptainLaneListing`) at
  `CAPTAIN_LANE_OBSERVATION_PATH`.
- Operator conversations (ADR 0032, VUH-769) —
  the strict, provider-neutral app boundary:
  conversation records, the discriminated
  `OperatorConversationStreamEventSchema` union
  (message/reasoning/tool/input/auth/session/turn
  /worker_transcript/unsupported), bounded replay
  pages with typed recovery codes,
  revision-fenced submits (message /
  input_response / worker_steer — never
  approvals), and the callable service envelope
  (`OperatorConversationServiceRequest`/`Result`)
  mounted at `OPERATOR_CONVERSATION_DISPATCH_PATH`.
  `createOperatorConversationServiceClient` is
  runtime code: a dispatch-injected client whose
  `tail` yields events then STOPS on a typed
  recovery item rather than silently resyncing.
- `CommandAuthoritySchema` / `IntentContextSchema`
  — lane→authority-tier consistency enforced by
  superRefine.
- Event stream identity — `EVENT_STREAM_KINDS`,
  the reserved-namespace table, and
  `eventStreamKindForId` (longest-prefix match;
  unreserved ids are missions). `DomainEventSchema`
  keeps `streamKind` optional so sealed hashes of
  historical events stay stable.
- Captain presence (ADR 0016-era events) — lease
  identity, online/offline/heartbeat/turn events,
  and the `CaptainPresenceReport` wire shapes.
- `CAPTAIN_SILENT_REPLY_SENTINEL` — the
  `[[stay-silent]]` reply he may return to say
  nothing at all.
- Turn media (ADR 0085/0088) —
  `GENERATED_MEDIA_DIRECTORY` /
  `BROWSER_ARTIFACT_DIRECTORY`,
  `isGeneratedMediaRef` / `isBrowserArtifactRef`
  / `isAttachableTurnMediaRef` (strict
  one-segment sha256 refs), `CaptainTurnMedia`,
  and `CaptainChannelTurnResultSchema`
  (settled / silent / waiting_user / failed).
- Discord presence (ADR 0024/0048) — transport
  kinds (bot vs user_session), the frozen action
  enum with its risk-class and payload-kind
  tables, channel identity, bounded turn requests
  with image attachments (refs, never bytes),
  voice-presence notes, `DiscordPresenceWrite`
  with attribution refinements, and
  `resolveDiscordPresenceLedgerContent`. Plus the
  durable user-session opt-in record.
- Device pairing (VUH-727) — grant sets (Supervise
  preset; `terminalControl` never grantable),
  device records/events, and the redeem/complete
  wire shapes with content-free error codes.
- Embodiment (ADR 0063) — asked-play intents,
  session records, the frozen
  `EMBODIMENT_SESSION_TRANSITIONS` map and
  `canTransitionEmbodimentSession`, claims,
  assignments, receipts, `BodyPossession` reads,
  lifecycle reports, and the captain's
  `EmbodimentPlayNote` outcomes.
- Discord person memory (ADR 0042) — bounded
  approved facts keyed by stable ids (never
  display names or transcripts), proposals,
  projections, export/delete results.
- Browser (ADR 0082) — doctrine-projected tool
  descriptors/catalog, call requests, and results
  where refusal is a normal outcome; artifacts
  travel as hash-bound refs, never base64.
- Media generation (ADR 0085) — image and video
  request/result schemas; refusals are sayable
  reasons, video renders resume by `requestId`.
- Captain episodes (ADR 0054) — self-authored
  activity summaries, distinct from world facts.
- Discord voice evidence (ADR 0057) — the
  realtime-voice receipt union (joined, consent,
  utterance, floor, response, volition, overlap,
  interrupted, failed, left, possessor_*);
  content-free scalars only, with fast-path /
  handoff invariants enforced by superRefine.
