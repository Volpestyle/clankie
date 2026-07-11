# Pi worker adapter

The adapter drives Pi's JSONL RPC mode, derives `nativeSessionId` from session
statistics, and preserves the engine-issued `workerRunId` on all emitted events.

Quirks:

- Pi runs with `--no-session` unless a session directory is configured; RPC statistics may still expose a run-local ID.
- Cancellation sends the RPC `abort` request, waits for `agent_settled`, then collects final state and statistics.
- RPC `turn_start`, `agent_settled`, and blocking `extension_ui_request`
  dialog messages produce Tier-0 worker status events without inspecting
  terminal output.
- Only redacted message/tool deltas enter semantic events; raw provider payloads do not.
- Contract tests inject a recorded RPC client and never require a Pi provider credential.
