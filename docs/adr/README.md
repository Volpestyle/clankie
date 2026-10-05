# Architecture decision records

ADRs preserve why a decision was ratified. `accepted` means ratified, not
necessarily implemented or still current. Superseded records remain in place;
later ADRs link back to the decision they amend or replace.

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

[ADR 0215](0215-conversations-lease-one-body.md) proposes exclusive body-resource
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

- [0226 — Quick actions are skills, and tidy keeps results](0226-quick-actions-are-skills-and-tidy-keeps-results.md)

[ADR 0214's VUH-1678 amendment](0214-linear-wakes-require-attribution-and-rules.md#amendment--one-ordinary-chat-receives-signed-linear-activity-2026-10-04)
supersedes ADR 0218's Linear routing extension: verified rule-passing webhooks
wake one ordinary configured chat, `global-default` by default, and retire the
separate Linear inbox protocol. Clankie can set the non-secret target and rules.

- [0227 — Discord connects a server with a role](0227-discord-connects-a-server-with-a-role.md)
