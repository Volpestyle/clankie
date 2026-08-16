# apps/vox/src/ipc_router.rs

Routes each inbound IPC message from `AppState` to the matching connection, capture, playback, or stream-publish supervisor. Its boolean result lets the central loop stop cleanly when a playback/destroy command requests process termination.
