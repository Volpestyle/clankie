# Codex worker adapter

The adapter assigns one governed task to a Codex App Server turn and preserves
the App Server thread ID as `nativeSessionId`. Provider notifications and the
`worker.native_session.bound` event carry the engine-issued `workerRunId`.

Quirks:

- Each `run` owns and closes one App Server client; explicit resume is not yet exposed.
- Cancellation forwards `AbortSignal` as `turn/interrupt` and still waits for the terminal turn event.
- Strict inline named profiles start from the minimal system filesystem set. They grant only the runtime candidate root, synthetic tool home, and exact executable search directories; network, host-private paths, login shells, and ambient shell environments remain unavailable.
- App Server initialization opts into the named-permission protocol, and readiness proves an arbitrary outside sentinel is unreadable through sandboxed `command/exec` before advertisement.
- `turn/start.clientUserMessageId` is the engine-issued `workerRunId:attempt`.
- Only authoritative `item/completed` command/file payloads become semantic completion events; commands, output, paths, and patches are replaced by minimized counts and SHA-256 fingerprints.
- App Server `turn/started`, `turn/completed`, approval, elicitation, and
  `requestUserInput` messages produce Tier-0 worker status events; terminal
  output is never inspected for state.
- Contract tests inject a recorded client transport and never require Codex credentials.
