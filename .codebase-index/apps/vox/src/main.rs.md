# apps/vox/src/main.rs

Bootstraps rustls, IPC lanes, shared queues, `AppState`, and the native event sources. A single `tokio::select!` loop multiplexes IPC, voice/music events, reconnect deadlines, and a skip-on-lag 20 ms audio tick while recording rate-limited slippage telemetry.
