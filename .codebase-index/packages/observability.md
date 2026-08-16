# packages/observability

`@clankie/observability` — the tiny shared
logging/tracing layer: a pino logger factory with
secret redaction baked in, an OpenTelemetry
`withSpan` helper, and support-bundle
sanitization. Every service and app logs through
this so tokens can never reach a log line.

Children:

- package.json — deps: `@opentelemetry/api`, pino
- src/ — `index.ts`, the whole module
- test/ — redaction tests
- tsconfig.json — typecheck-only build
