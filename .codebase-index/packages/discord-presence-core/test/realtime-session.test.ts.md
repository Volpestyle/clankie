# packages/discord-presence-core/test/realtime-session.test.ts

Both realtime tiers over a fake socket factory
and injected timers. Conversation: session.update
opens with VAD that can neither create nor
interrupt responses and exactly the ask_clankie
tool; response.create only via createResponse;
appendAudio zeroing the caller's buffer on every
path; per-response audio byte cap failing closed;
the ask_clankie round trip
(function_call_output → response.create);
deliberate truncate; the lifetime cap; bounded
text items/instruction updates; content-free
response metadata; text modality (no model mouth,
bounded text deltas, per-response text cap with
reset, onTextDelta required); the API key living
only in connection headers and never in frames or
error text; loopback ws allowed; idempotent close
reporting the first reason. Transcription: opens
as a transcription session surfacing deltas and
completions, bounds surfaced text, never sends
response.create or conversation.item.create
whatever it hears, and enforces lifetime/remote
close reporting.
