# Documentation library

For using Clankie, start with the [public field guide](https://docs.clankie.bot):
[get started](https://docs.clankie.bot/get-started/),
[everyday use](https://docs.clankie.bot/using-clankie/), and
[DIY customization](https://docs.clankie.bot/diy/).
This directory and the module READMEs hold the technical references.

## Operate and configure

| Reference                                       | Canonical scope                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------- |
| [CLI](cli.md)                                   | Headless commands, flags, output, and local/hosted modes            |
| [Console](../apps/tui/README.md)                | Terminal interaction, workspaces, and launcher behavior             |
| [Distribution](distribution.md)                 | Installed layout, runtime ownership, release build and verification |
| [Credentials](credentials.md)                   | Secret identities, setup, rotation, and authority                   |
| [Always on](always-on.md)                       | Host sleep, the awake-Mac option, and the hosted-body alternative   |
| [Memory](memory.md)                             | Episodes, person facts, visibility, retention, and operator control |
| [Bundled skills](bundled-skills.md)             | Skill sources, discovery, and worker distribution                   |
| [Model keys](model-keys.md)                     | Paired-device API for model credentials and selection               |
| [Worker access](worker-access.md)               | Restricted grants for connected tools                               |
| [Tracker identity](worker-tracker-identity.md)  | Connected-account enforcement and remaining isolation work          |
| [Discord media](discord-media.md)               | Voice, music, Activity, Go Live, and screen-share differences       |
| [Remote Discord ingress](discord-ingress.md)    | Authenticated sealed text ingress protocol, independent of rollout  |
| [Desktop control](desktop-control.md)           | Native computer-use workflow and evidence limits                    |
| [Rivals integration](rivals.md)                 | Separate game bridge, including its explicit disabled status        |
| [Linux self-hosting](../infra/hosted/README.md) | Single-owner container deployment and supported capability set      |

## Understand and extend

[Architecture](architecture.md) owns the current system shape and request flows.
[Instruction and skill evals](evals.md) documents the isolated subscription runner.
[Product vocabulary](product-vocabulary.md) defines chats, agents, rooms, history,
sessions, and connections in the TUI. [Contributing](../CONTRIBUTING.md) owns the
source setup and checks.

| Area                              | Owning reference                                                                                                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service HTTP contract             | [OpenAPI](../apps/clankie/openapi.yaml), rendered as the [API docs](https://docs.clankie.bot/api/)                                                                   |
| Public wire contracts             | [`packages/protocol`](../packages/protocol/README.md)                                                                                                                |
| Coordination and worker routes    | [Swarm host](../packages/swarm/README.md)                                                                                                                            |
| Harness discovery and transcripts | [Agent hosts](../packages/agent-hosts/README.md), [transcripts](../packages/agent-transcript/README.md)                                                              |
| Project work tracking             | [Work items](../packages/work-items/README.md)                                                                                                                       |
| Models                            | [Provider resolution](../packages/model-provider/README.md), [catalog](../packages/model-registry/README.md)                                                         |
| Configuration                     | [Settings](../packages/settings/README.md), [credential broker](../packages/credential-broker/README.md)                                                             |
| Persona images                    | [Owner image folders](persona-images.md), voice descriptions and self-depiction                                                                                      |
| Images and video                  | [Media connector](../packages/media-connector/README.md)                                                                                                             |
| Game play                         | [Play mind](../packages/play/README.md), [rendered contract](../packages/interactive-environment/README.md)                                                          |
| Gameplay commentary               | [Play voice](../packages/play-voice/README.md)                                                                                                                       |
| Discord                           | [Official bot](../apps/discord-bridge/README.md), [shared behavior](../packages/discord-presence-core/README.md), [lab body](../apps/discord-user-session/README.md) |
| Native Discord media              | [Vox](../apps/vox/README.md), [client boundary](../packages/vox-client/README.md)                                                                                    |
| Game watch surface                | [Discord Activity](../apps/discord-activity/README.md)                                                                                                               |
| Remote device access              | [Relay](../apps/relay/README.md), [public network](https://docs.clankie.bot/network/)                                                                                |
| Optional terminal integrations    | [Herdr plugin](../integrations/herdr-plugin/README.md), [Claude seat](../integrations/claude-plugin/README.md), [Codex seat](../integrations/codex-plugin/README.md) |
| Documentation and branding        | [Docs site](../apps/docs/README.md), [public marks](../branding/README.md)                                                                                           |
| Public deployment                 | [AWS boundary](../infra/aws/README.md), [docs hosting](../infra/aws/public-docs/README.md)                                                                           |

## Proposals, decisions, and evidence

- [ADRs](adr/README.md) preserve decisions, amendments, and superseded designs.
  Read the current references above for operational instructions.
- [Testing archive](testing/README.md) contains dated proofs and their limitations;
  [quality gates](testing/quality-gates.md) define the recurring checks.
- [Desktop runtime design](desktop-runtime-design.md) is a dated proposal, not an
  implemented replacement for the desktop-control path.
- [Discord surface review](proposals/2026-09-30-discord-surface-review.md) is a
  dated proposal on retiring the Activity and the user-session lab body, awaiting
  a decision.
- [Ruthless cut audit](proposals/2026-09-30-ruthless-cut-audit.md) is a dated
  keep, cut or fold proposal for every surface under ADR 0203, awaiting James's
  line-by-line decision.
- [Fleet-lead transfer](fleet-lead-handoff.md) is a retained, inactive runbook.
  Normal external-coordinator connection is documented in the Swarm reference.

Every fact has an owning source. The public site renders canonical command and
API references rather than maintaining another copy. Its user guides explain
what to do and link here for the mechanics.
