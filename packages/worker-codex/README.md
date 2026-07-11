# Codex worker adapter

The adapter assigns one governed task to a Codex App Server turn and preserves
the App Server thread ID as `nativeSessionId`. Provider notifications and the
`worker.native_session.bound` event carry the engine-issued `workerRunId`.

Quirks:

- Each `run` owns and closes one App Server client; explicit resume is not yet exposed.
- Cancellation forwards `AbortSignal` as `turn/interrupt` and still waits for the terminal turn event.
- Implementation-like tasks use `workspaceWrite`; other task kinds use `readOnly`.
- Contract tests inject a recorded client transport and never require Codex credentials.
