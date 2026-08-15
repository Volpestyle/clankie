# packages/observability/test/observability.test.ts

Checks `sanitizeForSupportBundle` redacts nested
secrets, and that a `discord_bot` credential
marker survives neither support sanitization nor
structured logging unredacted.
