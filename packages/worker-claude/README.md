# Claude worker adapter

The adapter consumes the Claude Agent SDK async message stream. The SDK `init`
session ID becomes `nativeSessionId`, and every provider/session event preserves
the engine-issued `workerRunId`.

Quirks:

- The adapter has no native terminal stream; lifecycle evidence comes from structured SDK messages.
- Cancellation is forwarded through the SDK `AbortController` and may reject the run promise.
- No ambient setting source is loaded by default. The runner passes explicit settings and an allowlisted environment.
- The Agent SDK sandbox is enabled with unavailable/unsandboxed fallback denied. Credential environment variables remain available to the parent SDK process but are removed from tools; provider, runner, and host-private paths are denied.
- Verification/review expose only Read, Glob, and Grep. An always-on programmatic hook resolves each path against the candidate and denies outside or symlink-escaped reads before tool execution. Glob and Grep glob inputs conservatively reject traversal, absolute paths, tilde expansion, backslashes, braces, and extglobs. Trusted commands belong to the runner.
- The first assistant message, result message, and open `canUseTool` callback
  produce Tier-0 working, settled, and waiting-user events. Permission prompt
  summaries come from SDK metadata, never terminal text.
- Contract tests inject a recorded query transport and never require Anthropic credentials.
- The `environment` option forwards an allowlisted worker environment to the SDK
  subprocess, replacing the inherited process environment so runner/captain/connector
  secrets never leak into the worker. Omitting it preserves the SDK default of
  inheriting `process.env`.
