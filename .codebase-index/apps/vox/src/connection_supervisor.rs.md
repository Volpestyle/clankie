# apps/vox/src/connection_supervisor.rs

Owns connection commands for primary voice, `stream_watch`, and `stream_publish`, validating numeric identities and complete pending credentials before constructing role-specific `VoiceConnection`s. Primary voice retries indefinitely after failures with exponential delays capped at 16 seconds and reissues the gateway voice-state update; watch and publish perform one connect attempt per explicit command and emit failure without entering that reconnect loop.
