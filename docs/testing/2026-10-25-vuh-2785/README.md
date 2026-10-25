# VUH-2785: canonical Hoodie default

The public appearance schema now defaults an absent lead selection to
`clankie.lead.hoodie`. Explicit `pack` (Classic), custom IDs, pet skin and
navigation remain independent. The app removal and migration are reviewed in
the separate `clankie-app` candidate.

- `clankie heavy -- node_modules/.bin/vitest run apps/clankie/test/appearance-settings.integration.test.ts`: 6 tests pass. Real HTTP routes backed by SettingsStore prove missing documents/lead fields select Hoodie, explicit Classic survives persistence, pet updates preserve the lead, and revision/authority validation stays enforced.
- Consumer compatibility: candidate default, explicit Classic and custom-ID snapshots/update envelopes parse using the installed schemas resolved from app device-session, ops gateway and ops fleet. The candidate's default remains a valid string ID under the existing protocol. No ops source changes are needed.
- No art or `packages/lead-skin` compiler change. Core ADR 0082 concerns browser ownership; the app's ADR 0082 records the skin retirement. Core ADR 0248 records this default amendment.

Recorded results: `Test Files 1 passed (1); Tests 6 passed (6)`.
The three installed consumer schemas each accepted default, Classic and custom
appearance snapshots and updates. These are isolated integration and parsing
proofs, with no live service restart, release or owner preference write.
