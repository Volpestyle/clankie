# ADR 0301: Claude reaches the fleet through a narrow connector

Status: Accepted by James, 2026-10-29. Builds on
[ADR 0300](0300-clankie-runs-only-on-the-owners-machine.md) and the doorway of
[ADR 0204](0204-a-self-hosted-mac-pairs-the-app-directly.md).

## Context

James wants Claude, in the Claude apps, to see the agents running in Herdr on
his work Mac and on the PCs that build games, and to message them, without
opening the Clankie app. Claude connects to tools through remote MCP servers
that it adds as custom connectors, signs in with OAuth 2.1, and calls from
Anthropic's own servers. Nothing on Anthropic's side can hold a Clankie device
key or speak the doorway's end-to-end encryption.

## Decision

The Mac serves a remote MCP server, reached at
`https://api.clankie.bot/h/{hostId}/mcp` through the doorway, or at the relay's
own `/mcp` on a trusted network.

- **Three tools.** `list_agents` names each agent with its machine and
  project, `read_agent` returns the text on its screen, and `message_agent`
  writes into its own persona thread, which delivers to the native pane. A
  connector never types into a terminal, hires or closes a seat, writes to a
  tracker, reads settings, tails Clankie's own thread, or joins a call.
- **Signing in pairs a device.** The service is the OAuth authorization server
  (RFC 8414 metadata, RFC 7591 registration, PKCE S256). Registration is
  stateless: the client id carries its name and callbacks under the Mac's key.
  Only Claude's hosted callback and loopback addresses can receive a code. The
  sign-in page shows a short code, and the owner approves it with
  `clankie connector approve CODE`. The same owner route accepts the app's
  Take Control devices, so the app can offer approval later. Approval pairs one device
  with `scope: "connector"` and `CONNECTOR_GRANTS`; its device session token is
  the access token (an hour), and refresh tokens rotate on every use and stop
  working after 90 idle days. `clankie devices revoke` ends both.
- **Narrow by the scope, not the grants.** The service answers a connector
  device only at `GET /v1/devices/self`. The relay holds it to its op
  allowlist, and confirms each send or read is for a persona thread before it
  dispatches.
- **Plaintext through the doorway, for this route only.** The gateway carries
  the connector's discovery, OAuth and `/mcp` calls in plaintext, with the
  `authorization` header only on `/mcp` and a query only on the sign-in link.
  It also answers RFC 8414 and RFC 9728 discovery at the origin's root
  (`/.well-known/oauth-authorization-server/h/{hostId}`). Everything else still
  needs gateway encryption. The Mac's gateway connector names the public base
  in `x-clankie-public-base`, so discovery documents name doorway URLs.

## Consequences

- The gateway terminates TLS for connector calls and can read pane text and
  messages on their way through. James accepted this for the connector; the
  app's own traffic stays end-to-end encrypted.
- Pane text from another agent is information to Claude, never instructions,
  and the MCP server says so in its instructions.
- Approve only a code you see on your own sign-in page: whoever opened that
  page receives the access.
- Connector budgets are per host because Claude's servers share a few
  addresses; the sign-in page also has a per-client budget.
