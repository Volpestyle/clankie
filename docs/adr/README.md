# Architecture decision records

ADRs preserve why a decision was ratified. `accepted` means ratified, not
necessarily implemented or still current. Superseded records remain in place;
later ADRs link back to the decision they amend or replace. Read the
[current architecture](../architecture.md) for the implemented system; the archive
below identifies decisions whose former implementation or scope is historical.

## Conventions

- Put current setup, commands, configuration, and implementation state in the
  owning app or package README. ADRs keep the decision, evidence, alternatives,
  and consequences.
- Link amendments and superseding decisions in the status paragraph. Historical
  implementation details stay explicitly historical rather than claiming to
  describe the running system.
- When a decision retires guidance that agents or users read, add the retired
  phrasing to [retired-claims.json](retired-claims.json). `pnpm docs:check` then
  fails wherever live code, skills or guides still repeat it.
- Link ADRs by stable filename, not by number alone. Accepted ADRs are never
  renumbered.
- Numbers 0098, 0189 and 0191 each identify two records. Use these disambiguating aliases:

| Alias                          | Stable record                                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| ADR 0098 (room text)           | [The room can type to a playthrough](0098-the-room-can-type-to-a-playthrough.md)                               |
| ADR 0098 (user-session shares) | [The lab user body watches Discord shares through ClankVox](0098-user-session-watches-discord-shares.md)       |
| ADR 0189 (agent sessions)      | [Agent sessions read from their transcripts](0189-agent-sessions-read-from-their-transcripts.md)               |
| ADR 0189 (Linear echoes)       | [His own Linear activity does not wake him](0189-his-own-linear-activity-does-not-wake-him.md)                 |
| ADR 0191 (reply routing)       | [A reply to his post goes to whoever owns the work](0191-a-reply-to-his-post-goes-to-whoever-owns-the-work.md) |
| ADR 0191 (work tracking)       | [Work is tracked where the repo tracks it](0191-work-is-tracked-where-the-repo-tracks-it.md)                   |

## Diagram sources

[ADR 0210](0210-objectives-outlive-agent-turns.md) records the separation of
native goals, explicit session assignments and current activity.

| Editable source                                                                          | Export                                                                                                      |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [`clankie-current-architecture.tldraw`](../diagrams/clankie-current-architecture.tldraw) | Historical [`clankie-current-architecture.jpg`](../diagrams/clankie-current-architecture.jpg)               |
| [`vox-architecture.tldraw`](../diagrams/vox-architecture.tldraw)                         | Historical [`vox-architecture.jpg`](../diagrams/vox-architecture.jpg)                                       |
| [`clankie-memory.tldraw`](../diagrams/clankie-memory.tldraw)                             | Historical [`clankie-memory.jpg`](../diagrams/clankie-memory.jpg)                                           |
| [`clankie-docs-diagrams.tldraw`](../diagrams/clankie-docs-diagrams.tldraw)               | Historical per-ADR JPG exports that remain linked                                                           |
| [`clankie-docs-diagrams-2.tldraw`](../diagrams/clankie-docs-diagrams-2.tldraw)           | Historical app, package, and ADR JPG exports that remain linked                                             |
| [`seat-conversations.tldraw`](../diagrams/seat-conversations.tldraw)                     | [`0135-a-herdr-seat-is-a-conversation.jpg`](../diagrams/0135-a-herdr-seat-is-a-conversation.jpg) (ADR 0135) |

Current architecture decisions use Mermaid in the owning Markdown; a decision
whose system spans repos may additionally keep an editable tldraw source listed
here with its export. Retained JPG exports preserve the architecture at their
publication date; do not treat them as current or hand-edit/fabricate a binary
render without its source.

[ADR 0215](0215-conversations-lease-one-body.md) records exclusive body-resource
leases for parallel conversations belonging to one Clankie.

[ADR 0216](0216-projects-own-agent-roles-and-tool-policy.md) moves agent roles and
project policy into owner settings, with lossless persona migration and per-agent
membership rules.

[ADR 0217](0217-fleet-membership-gets-connected-tools.md) supersedes ADR 0216's
fleet tool gate: admitted fleet members reach verified connected accounts through
`clankie_tools` and `clankie_call`, with an owner kill switch.

[ADR 0218](0218-native-seats-drive-their-attached-conversation.md) lets native
harness seats drive a selected conversation, preserving room grants and delivery
receipts across handover, and routes worker reports to their persisted lead.

[ADR 0220](0220-clankie-has-one-present-tense.md) adds one `presence` operator
operation, a `desktop` tool for his own expressions, and hero pixel art in
`branding/pet/`; the desktop pet itself lives in the private app.

[ADR 0221](0221-tests-prove-the-product-and-its-boundaries.md) prioritizes real
E2E, integration and golden coverage for new work; existing unit-test pruning
remains a separate reviewed effort.

- [0222 — Discord setup has one shared definition](0222-discord-setup-has-one-shared-definition.md)
- [0225 — Minecraft keeps playing with one driver](0225-minecraft-keeps-playing-with-one-driver.md)

- [0226 — One tracker tool surface](0226-one-tracker-tool-surface.md)

[ADR 0214's VUH-1678 amendment](0214-linear-wakes-require-attribution-and-rules.md#amendment--one-ordinary-chat-receives-signed-linear-activity-2026-10-04)
supersedes ADR 0218's Linear routing extension: verified rule-passing webhooks
wake one ordinary configured chat, `global-default` by default, and retire the
separate Linear inbox protocol. Clankie can set the non-secret target and rules.

- [0227 — Discord connects a server with a role](0227-discord-connects-a-server-with-a-role.md)
- [0228 — Quick actions are skills, and tidy keeps results](0228-quick-actions-are-skills-and-tidy-keeps-results.md)
- [0232 — Hosted Connections use the body broker](0232-hosted-connections-use-the-body-broker.md)

- [0229 — Room handoffs are visible parallel threads](0229-room-handoffs-are-visible-parallel-threads.md)
- [0230 — Fleet responsibility is owner settings](0230-fleet-responsibility-is-owner-settings.md)
- [0233 — Activity shares own their media scope](0233-activity-shares-own-their-media-scope.md)
- [0234 — Games share one extension contract](0234-games-share-one-extension-contract.md)

## Archived decisions

**Archived** means superseded or retired for the scope named below. These records
retain their stable paths and historical rationale; archiving does not delete
an ADR or change the surviving constraints explicitly noted in its status.
The links in this table follow each record's current-status paragraph and the
superseding decisions.

| Status   | Record                                                                                                                                   | Archived scope / current decision                                                                                                                                                                                                            |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Archived | [ADR 0025: ClankVox is an in-repo voice sidecar behind versioned bridge IPC](0025-clankvox-placement-and-ipc.md)                         | Sole-owner media and native package placement. [ADR 0128: Vox is the sole Discord media owner](0128-vox-is-the-sole-discord-media-owner.md); [ADR 0100: Vox is an owned native media package](0100-vox-is-an-owned-native-media-package.md). |
| Archived | [ADR 0039: GBA emulator embodiment and the deterministic core boundary](0039-gba-emulator-embodiment-and-deterministic-core-boundary.md) | Local GBA body retired. [ADR 0145: The world is the only body](0145-the-world-is-the-only-body.md).                                                                                                                                          |
| Archived | [ADR 0040: Real headless mGBA core behind the emulator seam](0040-real-mgba-core-behind-the-emulator-seam.md)                            | Local mGBA core retired. [ADR 0145: The world is the only body](0145-the-world-is-the-only-body.md).                                                                                                                                         |
| Archived | [ADR 0044: The runner owns Mineflayer while Paper owns Minecraft success](0044-runner-owned-mineflayer-private-paper-gameplay.md)        | Runner-owned Minecraft body removed; current offline Minecraft uses an MCP motor. [ADR 0219: Minecraft is an MCP-connected body](0219-minecraft-is-an-mcp-connected-body.md).                                                                |
| Archived | [ADR 0053: An external harness possesses Clankie under a lease](0053-mcp-possession-of-clankies-body.md)                                 | Possession replaced by independent player identity. [ADR 0129: Each player owns a body](0129-each-player-owns-a-body.md); [ADR 0145: The world is the only body](0145-the-world-is-the-only-body.md).                                        |
| Archived | [ADR 0064: The possessor voice seam](0064-possessor-voice-seam.md)                                                                       | Possessor voice scope retired; neutral Clankie play voice survives. [ADR 0129: Each player owns a body](0129-each-player-owns-a-body.md).                                                                                                    |
| Archived | [0075. Rewinding is a play choice](0075-rewinding-is-a-play-choice.md)                                                                   | Local rewind retired. [ADR 0145: The world is the only body](0145-the-world-is-the-only-body.md).                                                                                                                                            |
| Archived | [ADR 0090: Emerald plays from the screen](0090-emerald-plays-from-the-screen.md)                                                         | Local screen-only Emerald implementation retired. [ADR 0145: The world is the only body](0145-the-world-is-the-only-body.md).                                                                                                                |
| Archived | [ADR 0125: The menu bar is a private local voice room](0125-the-menu-bar-is-a-private-local-voice-room.md)                               | Menu-bar voice room retired. [0203 — Clankie keeps what better models cannot absorb](0203-clankie-keeps-what-better-models-cannot-absorb.md).                                                                                                |
| Archived | [0180. Swarm owns cross-session coordination](0180-swarm-is-the-coordination-layer.md)                                                   | Swarm coordination retired. [ADR 0213: Clankie retires Swarm](0213-clankie-retires-swarm.md).                                                                                                                                                |
| Archived | [0182. Swarm peers are messageable personas](0182-swarm-peers-are-messageable-personas.md)                                               | Swarm peer personas retired. [ADR 0213: Clankie retires Swarm](0213-clankie-retires-swarm.md).                                                                                                                                               |
| Archived | [ADR 0194: Interactive Swarm workers receive leased channel events](0194-interactive-swarm-workers-receive-leased-channel-events.md)     | Swarm channel delivery retired. [ADR 0213: Clankie retires Swarm](0213-clankie-retires-swarm.md).                                                                                                                                            |
| Archived | [ADR 0198: One coordinator reaches every fleet](0198-one-coordinator-reaches-every-fleet.md)                                             | Swarm coordinator retired. [ADR 0213: Clankie retires Swarm](0213-clankie-retires-swarm.md).                                                                                                                                                 |
| Archived | [ADR 0205: The fleet carries its open Swarm tasks](0205-the-fleet-carries-its-open-swarm-tasks.md)                                       | Swarm task projection retired. [ADR 0213: Clankie retires Swarm](0213-clankie-retires-swarm.md).                                                                                                                                             |

### Archived scopes within continuing records

These ADRs retain a live boundary or an unimplemented proposal. Only the named
scope is archived; readers should follow the successor for its implementation.

| Record                                                                                                                  | Archived scope                                                           | Continuing boundary / successor                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [ADR 0045: Official-bot group voice uses the maintained Discord media stack](0045-official-bot-dave-group-voice.md)     | Archived: Node voice/Opus media owner and split-stack rollout.           | Consent, attribution, floor, and positive DAVE evidence remain; media ownership follows [ADR 0128: Vox is the sole Discord media owner](0128-vox-is-the-sole-discord-media-owner.md).    |
| [ADR 0059: Lease expiry pauses the body; only revocation is final](0059-lease-expiry-pauses-the-body.md)                | Archived: Possession and cross-process body lock.                        | Internal action/lease recovery is retained in its applicable scope; independent body ownership follows [ADR 0129: Each player owns a body](0129-each-player-owns-a-body.md).             |
| [ADR 0129: Each player owns a body](0129-each-player-owns-a-body.md)                                                    | Archived: Local emulator body.                                           | Independent player identity remains; the Pokémon body follows [ADR 0145: The world is the only body](0145-the-world-is-the-only-body.md).                                                |
| [ADR 0170: A session that stops is unbound](0170-a-session-that-stops-is-unbound.md)                                    | Archived: Ambient selection and automatic replacement of a lost session. | Explicit binding and its current CLI contract follow [0181. Clankie is independent of his connections](0181-clankie-is-independent-of-his-connections.md).                               |
| [ADR 0189: Agent sessions read from their transcripts, on any host](0189-agent-sessions-read-from-their-transcripts.md) | Archived: Headless resumed turns and Swarm identity proposals.           | Transcript reading remains; native interactive work follows [0203 — Clankie keeps what better models cannot absorb](0203-clankie-keeps-what-better-models-cannot-absorb.md).             |
| [ADR 0208: Agents carry a role; the world reads it](0208-agents-carry-a-role-the-world-reads-it.md)                     | Archived: Identity-role storage.                                         | Roles move into project policy under [ADR 0216: Projects own agent roles and tool policy](0216-projects-own-agent-roles-and-tool-policy.md).                                             |
| [ADR 0216: Projects own agent roles and tool policy](0216-projects-own-agent-roles-and-tool-policy.md)                  | Archived: Fleet tool gate tied to project membership.                    | Project roles, caps, hiring, and tracker binding remain; connected tool access follows [ADR 0217: Fleet membership gets connected tools](0217-fleet-membership-gets-connected-tools.md). |
