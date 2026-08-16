# packages/credential-broker/src/linear-oauth.ts

Linear MCP OAuth 2.1 client. It dynamically
registers a localhost-callback public client,
uses authorization-code PKCE against
`mcp.linear.app`, exchanges and refreshes tokens,
and returns the credential-broker's typed OAuth
record without persisting it itself.

Exports endpoint/provider constants,
`generateLinearPkce`, `buildLinearAuthorizeUrl`,
`registerLinearOauthClient`,
`exchangeLinearAuthorizationCode`,
`refreshLinearOauth`,
`linearCredentialFromTokens`,
`linearOauthNeedsRefresh`, and
`runLinearBrowserLogin`.

The callback validates the path and state, has a
five-minute default timeout, escapes all HTML in
its result page, and preserves the old refresh
token when Linear rotates only the access token.
