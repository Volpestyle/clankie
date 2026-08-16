# ADR 0053: An external harness possesses Clankie under a lease

Status: accepted (James, 2026-07-25). The speech/hearing ports were implemented
by [ADR 0064](0064-possessor-voice-seam.md), admitted room text was added by
[ADR 0098 (room text)](0098-the-room-can-type-to-a-playthrough.md), and outbound
authorship was superseded by
[ADR 0074](0074-the-room-hears-one-voice.md). The possessor remains authoritative
for its own gameplay decisions, not for exact words heard by the room.

## Context

Publishing the emulator surface over MCP lets an external harness drive the same
body as Clankie's model-decided loop. It is also a strong test of the shared tool
surface: an external caller must inherit the same bounds, refusals, and observed
state rather than gaining a private path to the core.

## Decision

`apps/gba-mcp` is a consumer of the existing emulator contracts. Tool arguments
derive from shared action and observation schemas, every action dispatches
through `EnvironmentRuntime`, and the ROM loader is shared with the play host.
The MCP server does not define a second game body or capability catalog.

### A possessor holds no Discord gateway

The Discord presence path requires a live claim minted by the process holding
the gateway. A possessor holds no gateway and cannot mint that claim. Speech and
hearing therefore use ports to the gateway-owning process rather than a direct
presence action.

This preserves the key invariant: possession changes who drives the body, never
which Discord account is present or which room it occupies.

### Possession is a lease

Two drivers reaching the same core would produce conflicting intent. Taking the
body suspends the resident loop instead of arbitrating after both actions land.

- Observation needs no lease.
- Acting, reporting narration, and hearing require the lease.
- Stealing a live lease requires an explicit force operation.
- Leases expire so a crashed holder cannot retain the body forever.
- A separate cross-process body lock prevents two runtimes from each believing
  they are the only writer.

The body lock follows driving rather than MCP process startup, allowing idle MCP
servers to observe without monopolizing the body.

### A distinct principal and consent boundary

A possessor is neither an ordinary room participant nor the owner/operator
seat. It receives only the capabilities the possession surface exposes. Hearing
is downstream of the existing Discord admission and consent boundary, carries
transcripts rather than audio, and grants no new access merely because the
possessor asks.

Hearing is push-only. A pull-shaped "last N lines" API would require the bridge
to retain transcripts; instead, attributed utterances reach only live
subscribers and the possessor's bounded window is cleared on release.

### Disclosure and speech authorship

The owner decision at ratification was no in-channel possession announcement.
Lease transitions remain operator-visible. The residual risk is explicit: a
private room can be heard by a guest driver that participants cannot detect.
This decision must be revisited if the deployment stops being private and
owner-known or possession is delegated beyond the owner.

The original consequence that the account carried the possessor's verbatim
voice is no longer current. ADR 0064 makes the possessor report an event, and
ADR 0074 makes the realtime room session the sole author of what the room hears.

## Alternatives considered

- **Give the MCP server its own core path** was rejected because it would create
  a second capability definition and duplicate fail-closed behavior.
- **Let the resident loop and possessor drive concurrently** was rejected
  because arbitration after dispatch is too late.
- **Call Discord presence actions directly** was rejected because the live-claim
  fence correctly excludes a process with no gateway.
- **Use a pull transcript API** was rejected because it would create bridge-side
  retention.

## Consequences

- The emulator body is a single-machine resource with one active writer.
- Missing lease, bridge, credential, consent, or live voice state fails closed
  with a specific reason; play itself may continue silently.
- Possession remains operator-auditable without granting the harness Discord
  credentials or raw audio.
- Setup, commands, lock locations, tool semantics, and live operation belong in
  the [GBA MCP operating guide](../../apps/gba-mcp/README.md). The bridge-side
  media seam belongs in the
  [Discord bridge operating guide](../../apps/discord-bridge/README.md).
