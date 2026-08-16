# packages/credential-broker/test/credential-broker.test.ts

Small smoke suite for `CapabilityTokenIssuer`:
issues bounded, expiring grants that verify and
answer `allows()` correctly. The deep issuer
coverage lives in audited-capabilities.test.ts.
