# packages/observability/src/index.ts

Creates ISO-timestamped Pino loggers with standard Clankie context and a fixed secret-redaction path set. `sanitizeForSupportBundle` recursively censors token/key/secret/password fields; no tracing span or diagnostic-field API remains.
