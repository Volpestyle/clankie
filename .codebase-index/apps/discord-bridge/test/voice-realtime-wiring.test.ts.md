# apps/discord-bridge/test/voice-realtime-wiring.test.ts

Offline integration of the bridge's realtime
wiring over fake WebSocket factories: an
addressed transcript wakes the dormant listener
into an engaged session seeded with the
service-composed briefing, and with the
ElevenLabs provider configured (ADR 0070) the
engaged session runs text-modality with deltas
streamed through the fake TTS socket into the
same playback path.
