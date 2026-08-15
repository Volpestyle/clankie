# packages/api-client/test/api-client.test.ts

Verifies each route sends the right bearer and
validates payloads both ways: presence phase
events, bounded channel turns, presence actions
with the live-session claim headers, captain
presence reports, the unversioned-profileHash
health fallback, failing before the request when
no matching token is configured, and
captain-or-operator activity reads.
