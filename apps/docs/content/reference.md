# Reference

Choose the reference for the job. [Get started](/get-started/) covers setup;
[using Clankie](/using-clankie/) explains the everyday experience;
[Customize Clankie](/diy/) introduces the optional technical depth.

## Operate Clankie

| I want to…                                            | Read                                                                                                              |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Find a console command or keyboard shortcut           | [Console](/console/)                                                                                              |
| Script configuration, inspect status, or troubleshoot | [CLI](/cli/)                                                                                                      |
| Install a pinned release or understand its files      | [Distribution](https://github.com/Volpestyle/clankie/blob/main/docs/distribution.md)                              |
| Understand credentials and access                     | [Credentials](https://github.com/Volpestyle/clankie/blob/main/docs/credentials.md)                                |
| Inspect what he remembers                             | [Memory](https://github.com/Volpestyle/clankie/blob/main/docs/memory.md)                                          |
| Configure Discord voice, music, or a watch surface    | [Discord media](https://github.com/Volpestyle/clankie/blob/main/docs/discord-media.md)                            |
| Connect coding agents and other machines              | [Swarm support and runtime connections](https://github.com/Volpestyle/clankie/blob/main/packages/swarm/README.md) |
| Grant a worker limited use of a connected account     | [Worker access](https://github.com/Volpestyle/clankie/blob/main/docs/worker-access.md)                            |
| Run the service on Linux                              | [Self-hosted Linux](https://github.com/Volpestyle/clankie/blob/main/infra/hosted/README.md)                       |

## Integrate and contribute

| Reference                                                                            | Owns                                                      |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| [How he works](/how-it-works/)                                                       | A readable overview of the service and its connections    |
| [Architecture](https://github.com/Volpestyle/clankie/blob/main/docs/architecture.md) | Current system boundaries and request flows               |
| [HTTP API](/api/)                                                                    | The service's route catalog, rendered from OpenAPI        |
| [Public network](/network/)                                                          | The gateway's allowed host routes and their authorization |
| [Library index](https://github.com/Volpestyle/clankie/blob/main/docs/README.md)      | Subsystem references, design proposals, and evidence      |
| [Contributing](https://github.com/Volpestyle/clankie/blob/main/CONTRIBUTING.md)      | Source setup, checks, and repository boundaries           |

The CLI reference is rendered from its canonical Markdown. The console command
table, HTTP catalog, and public host-route table are generated from their source
registries. Generation keeps the catalogs aligned; implementation and release
availability still need their own verification.

## History and machine-readable docs

[Decision records](https://github.com/Volpestyle/clankie/tree/main/docs/adr) explain
why boundaries changed. They include superseded designs; use the current
references above for setup. [Dated verification records](https://github.com/Volpestyle/clankie/tree/main/docs/testing)
say what was tested on a particular revision and environment.

[llms.txt](/llms.txt) indexes these docs for agents.
[llms-full.txt](/llms-full.txt) contains the public guides, references, and
repository architecture in one Markdown document.
