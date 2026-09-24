# Clankie Claude Code plugin

Workers can use Clankie's connected tools without taking his operator seat:
configure `clankie mcp --grant FILE` using an individually issued private grant.
See [worker access](../../docs/worker-access.md) for account verification,
restrictions and expiry. Swarm enrollment does not automatically issue a grant.

An optional alternative to Clankie's primary TUI lead: his operator seat as a Claude Code plugin
([ADR 0152](../../docs/adr/0152-a-harness-takes-the-operator-seat.md)). Sit in
Claude Code on your own plan and you are talking to Clankie: his identity, the
owner persona, his tools over MCP, the newest memory card on every turn, and
his skills. The service keeps running his body, Discord, voice, and play.
When assigning work through `swarm_assign`, `skills: ["installed-name"]` attaches
selected skill files from that conversation's catalog to the worker's immutable
context. See [portable skill selection](../../packages/swarm/README.md#working-preferences-and-portable-skills-slices-36).

Running Claude Code as a worker in Clankie's Herdr fleet does not require
replacing the lead with this seat. Linear activity follows the issue's owning
conversation into its bound Claude seat as a wake; with no bound seat, Pi handles
the turn. Goal continuations remain with their service Pi loop.

Like the [herdr plugin](../herdr-plugin/README.md), this carries only what a
plugin can uniquely declare. Everything else lives in the service and the
`clankie` launcher.

## What the plugin carries

| Piece                                                                                                                                         | File                       | What it does                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Output style `Clankie`                                                                                                                        | `output-styles/clankie.md` | His identity in place of the coding assistant's; forced on while the plugin is enabled. Generated from `instructions.md`.    |
| `SessionStart` hook                                                                                                                           | `hooks/hooks.json`         | `clankie prompt --lane operator --sections persona,reach,fleet,address,model`: the owner persona, reach, address, model card |
| `UserPromptSubmit` hook                                                                                                                       | `hooks/hooks.json`         | `clankie memory-card --lane operator`: the newest memory card, every turn                                                    |
| MCP server `clankie`                                                                                                                          | `.mcp.json`                | `clankie mcp --lane operator`: his tool bank over stdio, bearer read from the broker, never from a config file               |
| Skills `/clankie:this-machine`, `/clankie:trace-clankie`, `/clankie:lead`, `/clankie:swarm-lead`, `/clankie:herdr-lead`, `/clankie:swarm-mcp` | `skills/`                  | Links to the shipped skills, available from any working directory                                                            |

The output style is generated: edit `apps/clankie/src/captain/instructions.md`
and run `node integrations/claude-plugin/build.mjs`. `node
integrations/claude-plugin/build.mjs --check` fails when the file is stale, and
the launcher's tests run that check.

This source also carries durable operating lessons, including delivery before
harness work, bounded fleet review, and acceptance-driven Linear updates.
The service prompt and this generated seat share them; episode memories are
ambient recollections, not a substitute. New checkout sessions consume the
updated files. Copied release or marketplace installs need their normal update
before new sessions receive the change.

## Launch

```bash
clankie seat              # sit down; a checkout loads this directory with --plugin-dir
clankie seat --conversation ID  # select an existing service project conversation
clankie seat --resume     # reopen the last seat's conversation
clankie seat --dry-run    # print the launch plan as JSON without starting Claude Code
```

`clankie seat` needs Claude Code on `PATH` and a TTY. It passes `--settings`
with the permission allowlist for `clankie` commands and, when the plugin is
installed, `enabledPlugins` for this session only; names the herdr pane
`clankie` when it is one; and starts Claude Code with `--name Clankie`. With
the plugin installed from the repo's marketplace it also passes the channel
development flag, so wakes and escalations reach the session; a `--plugin-dir`
seat gets his tools and skills but not his wakes, because the channel preview
accepts only marketplace-installed plugins.

`--conversation ID` resolves an existing global/workspace conversation through
`GET /v1/captain/seat-context`, starts Claude in its service-owned workspace and
binds the prompt, MCP tools and channel to that conversation. The selected
workspace must exist on the native host. `--resume` retains the binding and
refuses a different ID. Without a selection, the seat uses the default global
conversation. A selected project seat does not claim the global Herdr head name.

The launcher sets `CLANKIE_CONVERSATION_ID` for the plugin's hooks and MCP bridge;
inherited selections and worker Swarm capabilities are cleared. The prompt adds
the selected workspace's agent instructions through the same resource loader Pi
uses, with source paths, plus the owner's persona and fleet preferences. The
memory card remains the operator lane's shared recall; it is not project-filtered.
Pi and native leadership share task ownership and grant authority. Each selected
conversation has its own channel outbox, so its messages and replies stay in that
conversation. A bridge without a loaded Claude channel serves tools without
consuming events; queued work stays with the service.
Claude Code's interactive session receives channel events. Its `--print`/`-p`
mode serves MCP tools and transcript hooks but does not consume the outbox,
because that mode does not register channel notifications.
Without an available execution runtime, peer communication remains usable. The
plugin's operator bearer belongs to this trusted seat; it is not a worker credential.
Scoped access for other workers is tracked in the
[shared-account plan](../../packages/swarm/README.md#shared-connected-accounts-slices-35).

Install from a checkout or an installed release (`clankie doctor` names
`repoRoot`), then disable it at user scope: the forced output style applies to
every Claude Code session while the plugin is enabled there, and the seat is
the only session that should be him.

```bash
claude plugin marketplace add "$PWD/integrations/claude-plugin"
claude plugin install clankie@clankie
claude plugin disable clankie@clankie
```

Then confirm it took:

```bash
claude plugin details clankie          # output style, context/transcript hooks, one MCP server, six skills
clankie seat --dry-run                 # "plugin": { "source": "installed" }, "channel": true
```

In the session, `/mcp` lists the `clankie` server, `/clankie:this-machine`
loads his install skill, and `clankie model status` runs without a prompt.

## Codex

Codex is not a Claude plugin. It takes the same `clankie mcp --lane operator`
entry in its MCP config and the same skills directory; the seat is the tool
bank, not the harness.

## Troubleshooting

| Symptom                                    | Fix                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| He answers as Claude Code                  | The seat was not launched by `clankie seat`, which enables the plugin for its session      |
| Every Claude Code session answers as him   | The plugin is enabled at user scope; `claude plugin disable clankie@clankie`               |
| `/mcp` shows `clankie` failed              | The service is down or the operator credential is missing: `clankie status`                |
| No persona or memory card at session start | `clankie` is not on the hook's `PATH`; `pnpm cli:install` symlinks it into `~/.local/bin`  |
| Wakes never arrive                         | The seat was loaded with `--plugin-dir`; install from the marketplace for the channel flag |
| `claude plugin validate --strict` warns    | The skills are symlinks by design; sessions follow them, validation does not               |

## Native transcript projection

Launched seats publish settled messages and tools to their selected Clankie
conversation through `clankie seat-sync`. Native hook activity settles the app
after a stop, including when transcript records arrive after the channel reply.
This works outside Herdr and with
`--plugin-dir`; it does not require the Claude channel preview. The hook reads
and redacts on the Claude host, while the service deduplicates retries and pins
the native session to one conversation. Ordinary plugin use without the launcher
session binding does not publish. See [CLI sync contract](../../docs/cli.md#native-seat-transcript-sync)
and [Claude hook input](https://code.claude.com/docs/en/hooks#common-input-fields).
