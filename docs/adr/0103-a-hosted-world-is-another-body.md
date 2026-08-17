# ADR 0103: A hosted world is another body, behind a pinned contract

Status: proposed (2026-08-16). Amends
[ADR 0102](0102-pokeagent-mmo-is-an-external-mcp-world.md), which decided the
world would be reached only through the packaged MCP server. The shipped code
(VUH-970) reaches it through the pinned world contract instead; this record
states the boundary that is actually built and enforced.

## Context

ADR 0102 treated PokeAgent MMO as a tool surface: Clankie would call
`@pokeagent-mmo/world-mcp` through his generic MCP client and wrap the results.
That is the right shape for a harness whose relationship to the world is
tool calls.

Clankie's relationship to a game is not tool calls. `runFreePlay` drives exactly
one seam — `GbaDriverIo` — and everything above it (the model mind, the voice,
interjections, the journal, minted progress) never learns where the body is. The
activity publish path underneath it is equally concrete: a frame source with
digest dedupe so an idle screen costs no bandwidth, and dropped frames counted
rather than swallowed.

Reaching a hosted world through MCP tool calls would not have reused that. It
would have produced a second play loop beside the local one — a second frame
path, a second journal, a second set of interjection rules — to say the same
things about a different body.

## Decision

A hosted world is a second implementation of the `GbaDriverIo` seam plus a
rendered-media source, composed by the same execution the local body already
uses. It is not a second play loop.

Clankie reaches the world through `@pokeagent-mmo/world-protocol`, a git
dependency pinned to a revision, using the client transport on its `/ipc`
subpath — PokeAgent MMO
[ADR 0008](https://github.com/Volpestyle/pokeagent-mmo/blob/main/docs/adr/0008-the-contract-crosses-as-a-pinned-dependency.md)
ships that contract for exactly this crossing. `apps/clankie/src/world/body.ts`
holds the seam; `apps/clankie/src/play-execution-world.ts` composes it.
The operator- and Discord-visible surface is one captain tool, `pokeagent_join_mmo`.

The pinned player contract supplies control and frames. Ephemeral game sound
stays on the world's spectator-media boundary: the body mints its own unlisted
watch grant, reads live PCM with that read-only capability, and forwards bounded
packets to the Activity. This keeps spectator media out of the agent protocol
without creating a second emulator capture.

Adapter-owned state evolves behind that contract. FireRed adapter version 2
includes the decoded new-game name menus, which the body exposes through the
same `menu` observation as local play. A successful hosted menu action is
rendered from that pre-action entry only after the host reports that its live
cursor reached and confirmed it; an incomplete selection remains a refusal.

The boundary that survives from ADR 0102 is the one that matters: Clankie is a
player in that world, not its owner (PokeAgent MMO ADR 0001). He does not import
the world server, emulator core, mailbox, or persistence packages, does not run
the host, and does not reimplement the wire format — he links the contract that
defines it. `@pokeagent-mmo/firered` remains usable as transport-free cartridge
knowledge. The world CLI remains an operator debugging fallback.

![ADR 0103 local and hosted play bodies](../diagrams/0103-a-hosted-world-is-another-body.jpg)

[Editable Turbopuffer tldraw source](../diagrams/clankie-docs-diagrams-2.tldraw)

`apps/clankie/test/pokeagent-mmo-boundary.test.ts` enforces this: exactly
`@pokeagent-mmo/firered` and `@pokeagent-mmo/world-protocol` may be imported by
product source, and the host, server, and emulator packages may not be depended
on at all.

The seat is a credential, not a config value. The bearer lives in the credential
broker under `pokeagent_mmo_world`, and `CLANKIE_WORLD_CREDENTIAL` in the
environment is refused even when the broker also holds an entry, so a weaker
ambient credential cannot silently win ([credential guide](../credentials.md)).

## Consequences

- The mind, voice, journal, and activity publishing are unchanged by where the
  body is. A hosted world inherits them rather than reimplementing them,
  including live game sound when its host offers watch media.
- Clankie tracks a pinned contract revision. A world protocol change is a
  dependency bump, visible in review, not a silent wire drift.
- `@pokeagent-mmo/world-mcp` remains the path for harnesses that want tools, and
  remains what other agents use. Clankie no longer exercises it, so its
  regressions need coverage in the world's own repo rather than here.
- Three realities a local body never had must be handled in the seam, not
  papered over: there is no pause, because one player cannot stop a shared
  world; the screen can change with no action of his; and a body can be replaced
  under him by a region crossing or an operator takeover, which
  `bodyGeneration` detects and which invalidates everything cached about the
  screen.
- A refusal is something he can say out loud. `join_refused` names its reason —
  `no_credential`, `world_unreachable`, `world_full`, `region_not_hosted`,
  `world_refused` — and `pending` means the world is still spinning up, never
  that he is playing.
