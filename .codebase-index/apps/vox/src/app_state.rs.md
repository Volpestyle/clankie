# apps/vox/src/app_state.rs

Defines `AppState`, the serialized runtime spine holding voice/watch/publish connections, pending inputs, capture subscriptions, playback buffers, music/publish state, reconnect deadlines, and decode workers. It also owns global `TransportStats`, role-specific teardown, runtime-state clearing, and reconnect scheduling.
