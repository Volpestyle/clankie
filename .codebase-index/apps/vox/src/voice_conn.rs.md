# apps/vox/src/voice_conn.rs

Defines `VoiceConnection`, `VoiceEvent`, `TransportRole`, and connection parameters for Discord voice, watch, and publish legs. `connect()` performs the WebSocket/UDP handshake, codec and crypto setup, DAVE initialization, and task spawning; the handle exposes send/state operations and deterministic shutdown.
