# Pi worker adapter

The adapter drives Pi's JSONL RPC mode, derives `nativeSessionId` from session
statistics, and preserves the engine-issued `workerRunId` on all emitted events.

Quirks:

- The production runner supplies a persistent runner-owned session directory, and nominal completion without a native session ID fails.
- The published `@earendil-works/pi-coding-agent` dependency is pinned locally. An async process preparer lets the runner put the entire RPC process behind `ShellSandbox` before transport startup.
- Production configuration uses a synthetic home/config, disables ambient resources/telemetry/update checks, pins one local model, and reaches only the exact audited localhost Ollama host and port through the runner proxy. Readiness uses Pi's own HTTP dispatcher for an exact tags check and validates a nonempty RPC session ID, a session file canonically confined beneath the configured session root, and selected/available model state without inference.
- Cancellation sends the RPC `abort` request, waits for `agent_settled`, then collects final state and statistics.
- RPC `turn_start`, `agent_settled`, and blocking `extension_ui_request`
  dialog messages produce Tier-0 worker status events without inspecting
  terminal output.
- Only correlated completed command/file facts enter semantic events; command text, paths, arguments, output, and message deltas do not.
- Contract tests inject a recorded RPC client and never require a Pi provider credential.
