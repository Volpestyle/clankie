# Claude worker adapter

The adapter consumes the Claude Agent SDK async message stream. The SDK `init`
session ID becomes `nativeSessionId`, and every provider/session event preserves
the engine-issued `workerRunId`.

Quirks:

- The adapter has no native terminal stream; lifecycle evidence comes from structured SDK messages.
- Cancellation is forwarded through the SDK `AbortController` and may reject the run promise.
- Project settings are the default setting source; user/local settings require explicit configuration.
- The first assistant message, result message, and open `canUseTool` callback
  produce Tier-0 working, settled, and waiting-user events. Permission prompt
  summaries come from SDK metadata, never terminal text.
- Contract tests inject a recorded query transport and never require Anthropic credentials.
