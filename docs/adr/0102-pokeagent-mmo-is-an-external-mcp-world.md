# ADR 0102: PokeAgent MMO is an external MCP world

Status: accepted 2026-08-15, amended in part by
[ADR 0103](0103-a-hosted-world-is-another-body.md). The player/owner boundary
below still holds. The transport does not: Clankie reaches the world through the
`@pokeagents/world-protocol` contract, not through the MCP server. That contract
is now consumed as a published version; it crossed as a pinned git revision
under the `@pokeagent-mmo` scope until 2026-08-16.

## Context

PokeAgent MMO is a world any agent harness can enter. A Clankie-only connector
would couple his runtime to the host implementation and create a second
gameplay API.

## Decision

The transport in this section is retained as ratified and is not what runs.
ADR 0103 records the shipped seam and the reasoning that moved it; the paragraph
on what Clankie may not own carries forward unchanged.

Clankie interacts with PokeAgent MMO only through the packaged
`@pokeagent-mmo/world-mcp` executable and his generic MCP client. The MCP
process owns the world protocol, local transport, capability-filtered tools,
and session bearer. Clankie owns only his intent, tool calls, personality, and
presentation.

![ADR 0102 PokeAgent MMO external MCP world](../diagrams/0102-pokeagent-mmo-is-an-external-mcp-world.jpg)

[Editable Turbopuffer tldraw source](../diagrams/clankie-docs-diagrams-2.tldraw)

Clankie does not import the world protocol, server, emulator, mailbox, or
persistence packages, does not invoke the world CLI as an application
integration, and does not implement the world socket protocol. The CLI remains
an operator debugging fallback. `@pokeagent-mmo/firered` remains usable as
transport-free cartridge knowledge.

Architecture tests enforce this dependency and source boundary in both
repositories.

## Consequences

- PokeAgent MMO upgrades remain behind one harness-neutral MCP surface.
- Clankie exercises the same shipped path available to every other agent.
- Clankie-specific voice, personality, and streaming behavior can wrap MCP
  results without gaining host access.
