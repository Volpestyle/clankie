# packages/observability

Minimal structured-observability package centered on Pino logging and recursive secret redaction. It intentionally does not own OpenTelemetry spans or mission/worker diagnostic-field helpers.

- `package.json` — package metadata with Pino as the sole runtime dependency.
- `src/` — logger and support-bundle sanitizer.
- `test/` — redaction and logging tests.
- `tsconfig.json` — TypeScript configuration.
