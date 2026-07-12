# Logging, tracing, replay, and debugging

## Structured logs

Use `@clankie/observability` and Pino JSON logs. Required context where known:

```text
service version runnerId missionId taskId workerRunId
correlationId profileHash eventId provider nativeSessionId
```

Redact tokens, authorization headers, API keys, passwords, secret values, private audio, and raw user content by default.

## OpenTelemetry

Trace across:

```text
channel command
  → captain turn
  → plan validation
  → task lease
  → provider/native session
  → tool/process spans
  → verification
  → action policy
  → approval
  → connector side effect
  → evaluation
```

Propagate trace/correlation IDs through the relay and event stream. Terminal bytes are not span attributes; attach bounded metadata and artifact references.

Local development may send OTLP to the stack in `infra/observability/`. Production exporters are environment-configured and fail open for telemetry, never for mission execution.

## Event replay

`@clankie/event-store` stores hash-chained event records for local audit and deterministic projection — durable SQLite (`SqliteEventStore`, the control plane's mission log) and JSONL (`JsonlEventStore`, eval artifacts) backends share one chain format. Debugging starts from the event timeline:

1. verify hash chain;
2. replay mission projection;
3. identify first invariant divergence;
4. attach provider/terminal logs by worker run and sequence;
5. reproduce in a fixture;
6. create a bounded debug mission.

Agent-status precedence is rebuilt from the same semantic log. Inspect one worker or the captain with:

```bash
pnpm --filter @clankie/devtools dev status explain <workerRunId|captain> <domain-events.jsonl>
```

The explanation includes the current state and basis, winning tier/source/confidence/timestamp, the complete signal chain, and Tier-2 attention-only proposals. `worker.turn.settled` means an idle turn; only terminal `worker.settled` means completed worker execution. Terminal frames and pane text are never resolver inputs.

## Provider diagnostics

Preserve:

- native session/thread/turn IDs;
- command/process exit details;
- normalized lifecycle events;
- bounded stderr tail;
- tool names and timing, without sensitive arguments;
- session cost/token stats where available;
- sandbox/worktree/base commit.

Provider raw streams are optional diagnostic artifacts with shorter retention than semantic events.

## Terminal debugging

- strict sequence numbers;
- snapshots when replay gaps occur;
- control-lease transitions in semantic log;
- terminal size and encoding metadata;
- maximum buffer and artifact offloading;
- ANSI/control-sequence sanitization in non-terminal renderers.

## Support bundle

`pnpm support:bundle` creates a redacted archive containing versions, doctrine hashes, recent semantic logs, event-chain verification, and configuration shape. It excludes environment values, credentials, raw audio, full prompts, source files, and terminal history unless explicitly selected.

## Error reporting

Add Sentry to iOS/macOS and hosted services only after privacy defaults are configured:

- scrub breadcrumbs and request bodies;
- attach IDs, not prompt/source content;
- separate user opt-in diagnostics from required operational logs;
- allow self-hosted/no-telemetry mode.
