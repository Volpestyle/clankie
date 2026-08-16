# packages/discord-presence-core/src/realtime-session.ts

The OpenAI Realtime API boundary (ADR 0057): two
session classes over one injected WebSocket seam.

- `RealtimeTranscriptionSession` — the dormant
  tier (`gpt-realtime-whisper`): hears the
  consented mix, surfaces transcript deltas and
  completions, and is _structurally_ incapable of
  answering — the class has no response-emitting
  method at all. Pinned language default "en"
  (auto-detect garbles short turns).
- `RealtimeConversationSession` — the engaged
  tier (`gpt-realtime-2.1`): server VAD kept for
  boundaries only (`create_response` and
  `interrupt_response` forced false — the 1:1
  defaults are wrong in a group room); every
  response is an explicit `createResponse()` by
  the floor logic. The model's entire tool
  surface is `ask_clankie` (one string argument).
  Methods: `createTextItem` (speaker markers,
  seeds, briefings), `truncate` (deliberate
  barge-in), `updateInstructions`,
  `submitFunctionResult` (completes the tool
  round trip then responds). Supports
  `outputModality: "text"` (ADR 0070): the mouth
  goes away, deltas stream to `onTextDelta`.

Discipline shared via `RealtimeSessionCore`:
injected socket factory (`openRealtimeWebSocket`
is the production undici wrapper), WSS-or-
loopback URLs, API key only in connection
headers, outbound PCM zeroed on every path out of
`appendAudio`, per-response audio (1 min) and
text (8 000 chars) caps that fail closed, bounded
text items/instructions, a 10 s–4 h session
lifetime cap reported as `onClose("lifetime")`,
`session.truncation` retention defaults, and
server errors reduced to machine codes so
conversation content never reaches error text.
Openers: `openRealtimeTranscriptionSession`,
`openRealtimeConversationSession`.
