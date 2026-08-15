# packages/api-client

`@clankie/api-client` — the typed HTTP client for
the clankie service's control-plane API. One class,
`ClankieApiClient`, wraps every route the bridges,
runner hosts, and captain tools call, validating
responses against `@clankie/protocol` (and
`@clankie/interactive-environment`) schemas and
attaching the right bearer per route.

Children:

- package.json — depends on protocol +
  interactive-environment (workspace)
- src/ — `index.ts`, the client class
- test/ — auth-header and validation tests
- tsconfig.json — typecheck-only build

Flow: callers construct it with a base URL plus
optional runner/captain/operator tokens; each
method parses its request with the protocol schema
before sending and parses the response before
returning, so malformed traffic fails at the
boundary in both directions.
