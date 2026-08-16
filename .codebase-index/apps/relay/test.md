# apps/relay/test

Vitest suites plus recorded fixtures.
`operator-conversations.test.ts` covers
the whole HTTP/NDJSON boundary against
real local HTTP servers; `hub.test.ts`
covers the dev-tunnel schemas and the
approval-completion detector; `fixtures/`
holds the recorded React Native consumer
request/response and tail-stream data the
suite validates.
