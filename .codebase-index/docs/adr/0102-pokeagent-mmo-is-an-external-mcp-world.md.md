# docs/adr/0102-pokeagent-mmo-is-an-external-mcp-world.md

Accepted decision that Clankie enters PokeAgent MMO through the harness-neutral `@pokeagent-mmo/world-mcp` executable and its generic MCP client. The MCP process owns transport, capabilities, and session credentials; architecture tests prevent Clankie from importing the host, protocol, mailbox, persistence, or socket implementation.
