# ADR 0129: Each player owns a body

Status: accepted (James, 2026-08-19). Supersedes
[ADR 0053](0053-mcp-possession-of-clankies-body.md) and the possession-specific
parts of [ADR 0059](0059-lease-expiry-pauses-the-body.md). The
`EnvironmentRuntime` session/capability lease and its expiry recovery remain in
force.

## Context

The earlier local architecture treated one emulator as Clankie's body and let an
external harness temporarily take it under a cross-process lock. That coupled a
testing transport to identity, Discord room input, activity publication, and
the resident play loop. It also made ordinary resource ownership sound like one
agent could become another.

PokeAgents already models multiplayer correctly: the world authenticates
separate player seats, each seat addresses its own session and body, and the
player contract defines what that identity may observe or do. The local
architecture should preserve the same identity boundary even when every process
runs on one machine.

## Decision

**No process possesses Clankie.** No harness may take, steal, suspend, or speak
through his body, and no harness receives input from his Discord room. Clankie's
local play process owns its emulator/runtime for that process lifetime. An
external process owns a different body.

```mermaid
flowchart LR
  subgraph Clankie[Clankie's own play]
    Captain[Clankie service + play loop]
    Local[local emulator + runtime]
    Contract[pinned @pokeagents/world-protocol]
    Seat[hosted player seat + identity]
    Voice[@clankie/play-voice]
    Discord[active Discord body]

    Captain --> Local
    Captain --> Contract --> Seat
    Captain <--> Voice <--> Discord
  end

  subgraph Sandbox[External harness]
    GbaMcp[GBA MCP transport]
    Private[private emulator + runtime]
    GbaMcp --> Private
  end

  subgraph PokeAgents[PokeAgents hosted world]
    Other[other player or harness]
    Projection[PokeAgents MCP projection]
    Other --> Projection --> OtherSeat[separately credentialed seat]
    Seat --> World[hosted world]
    OtherSeat --> World
  end
```

### Local contract sandbox

`apps/gba-mcp` is an isolated emulator contract sandbox. Every stdio process
creates one private core, adapter, `EnvironmentRuntime`, session, and checkpoint
scope. Launching it grants the caller control only over that private core. It
has no Activity producer, play-voice client, Discord credential, room-input
subscription, possession API, or path to Clankie's running emulator.

### Hosted co-play

Co-play happens in PokeAgents hosted worlds through separately provisioned
player credentials and identities. `@pokeagents/world-protocol` owns the player
operation schemas and capability contract. The PokeAgents MCP server derives a
transport projection from that catalog and retains its caller's session token;
MCP does not define identity, authority, or gameplay semantics.

Clankie uses the pinned published `@pokeagents/world-protocol` package and its
native client transport because his existing play loop needs a body seam and
continuous frames, not a second tool-driven play loop. Clankie imports no
PokeAgents host, emulator, persistence, or world-MCP package in product source.
The operation catalog and MCP derivation are shipped in the sibling PokeAgents
repository. A stronger session-bound typed client or tighter catalog-only
dispatch belongs there as follow-up work; this ADR does not claim those
improvements are already integrated into Clankie.

### Clankie's voice belongs to Clankie

Clankie's local and hosted play use the neutral `@clankie/play-voice` loopback
package to connect his own game experience to whichever Discord body is active.
The Discord body remains the sole room author and sends only already-admitted
room input back to his play loop. GBA MCP and other external harnesses do not
receive this package, bearer, narration path, or room input.

### Runtime leases are not possession

`EnvironmentRuntime` keeps its internal session/capability lease. That lease
fences actions, expiry, pause, resume, cancellation, and restart recovery inside
the runtime that owns the environment. It does not transfer identity or let one
process take another process's body.

### Historical files remain inert

Existing `body.lock` and `possession-events.jsonl` files may remain on disk as
historical evidence. Current startup and play paths neither read nor write them.
There is no migration and no automatic deletion.

## Consequences

- Starting a harness cannot interrupt Clankie, publish as him, speak as him, or
  hear his room.
- Local parallelism costs one emulator/runtime per process instead of
  coordinating writers around one shared core.
- Hosted interaction uses the world's native player identity and capability
  model; transports project that contract rather than redefining it.
- Current operating details live in the
  [GBA MCP guide](../../apps/gba-mcp/README.md),
  [emulator guide](../../integrations/gba-emulator/README.md), and
  [play-voice guide](../../packages/play-voice/README.md).
