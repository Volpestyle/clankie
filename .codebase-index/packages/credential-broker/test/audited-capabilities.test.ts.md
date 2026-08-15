# packages/credential-broker/test/audited-capabilities.test.ts

Issuer and broker behavior: invalid/over-long
grant windows, tokens used before issue, and
noncanonical encodings rejected; resource-scoped
grants require an exact resource; issuance and
every use decision audited with fingerprints only
(no caller strings); use bound to trusted
mission/worker context; one-use replay protection
rehydrated across restarts with cross-broker
races resolving fail-closed; audit-append failure
fails the whole operation closed.
