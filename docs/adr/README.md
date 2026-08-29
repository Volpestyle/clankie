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
- Link ADRs by stable filename, not by number alone. Accepted ADRs are never
  renumbered.
- Two accepted records share number 0098. Use these disambiguating aliases:

| Alias                          | Stable record                                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| ADR 0098 (room text)           | [The room can type to a playthrough](0098-the-room-can-type-to-a-playthrough.md)                         |
| ADR 0098 (user-session shares) | [The lab user body watches Discord shares through ClankVox](0098-user-session-watches-discord-shares.md) |

## Diagram sources

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
