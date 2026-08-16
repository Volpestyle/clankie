# packages/observability/src/index.ts

Logging and tracing helpers shared by every
process.

Exports:

- `createLogger(context, options?, destination?)`
  — pino logger with a service/mission/task/run
  base context, ISO timestamps, level from
  `CLANKIE_LOG_LEVEL` (default info), and a
  default redact list covering authorization
  headers, tokens, API keys, passwords, and the
  known provider env names; censored as
  `[REDACTED]`.
- `childLogger(logger, context)` — child with
  narrower attribution.
- `withSpan(name, attributes, operation)` — runs
  the operation inside an active OTel span,
  records exceptions, and sets OK/ERROR status.
- `diagnosticFields(context)` — drops undefined
  entries from a diagnostic context record.
- `sanitizeForSupportBundle(value)` — deep-walks
  any value and replaces entries whose key looks
  secret-shaped (key, *token, *secret, *password,
  authorization, api key) with `[REDACTED]`.
