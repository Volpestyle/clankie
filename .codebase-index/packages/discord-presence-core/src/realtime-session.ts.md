# packages/discord-presence-core/src/realtime-session.ts

OpenAI Realtime API boundary (ADR 0057): two
session classes over one injected WebSocket seam.

- `RealtimeTranscriptionSession` — one dormant
  `gpt-realtime-whisper` listener per consented
  speaker. It surfaces bounded transcript deltas
  and completions and is structurally incapable
  of answering.
- `RealtimeConversationSession` — the engaged
  `gpt-realtime-2.1` tier. Server VAD marks
  boundaries but cannot auto-create/interrupt a
  response; the floor explicitly calls
  `createResponse()`.

The conversation tool surface sends privileged
work through `ask_clankie`, while read-only
`look_at_screen` and YouTube search/play/queue/
skip/pause/resume/stop/now stay local to the
call. Methods add bounded text or PNG image
items, append PCM, deliberately truncate barge-
ins, update instructions, and submit tool results;
text output mode supports an external TTS mouth.

`RealtimeSessionCore` owns the injected socket,
WSS-or-loopback restriction, header-only API key,
caller-buffer zeroing, bounded audio/text/image
outputs, 10-second–4-hour lifetime, truncation
policy, and machine-code-only error reduction.
Openers are `openRealtimeTranscriptionSession`
and `openRealtimeConversationSession`.
