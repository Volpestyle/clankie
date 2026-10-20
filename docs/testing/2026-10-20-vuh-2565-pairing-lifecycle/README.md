# VUH-2565 pairing lifecycle

2026-10-20, isolated source service; no live owner device or installed service
was modified. Core source is the commit containing this record.

- Five focused suites: 83 tests passed. New API regressions cover failed capture
  teardown, unused offers, pending registrations, unrelated run and ordinary
  owner preservation, expiry after replay, shared-registration grouping and
  explicit group-member revocation.
- Native capture-command integration: one test passed, exercising two real child
  processes (success and deliberate exit 7) over loopback HTTP. Both paired and
  authenticated a device; after each child exited every created pairing was
  revoked. This is a capture-runner lifecycle proof, not a simulator screenshot
  or physical-device proof. The fixture's health endpoint satisfies the CLI's
  isolated relay readiness probe; no relay traffic is claimed.
- Commands ran through `clankie heavy -- pnpm exec vitest run` with explicit test
  paths. Raw logs are retained in the evidence store, indexed by evidence.json.

The integrator's landing and paired app gate remain authoritative for delivery.
