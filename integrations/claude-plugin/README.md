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
replacing the lead with this seat. Linear notifications follow the connected account's inbox into the operator
conversation's bound Claude seat as a wake; with no bound seat, Pi handles
the turn. Goal continuations remain with their service Pi loop.

Like the [herdr plugin](../herdr-plugin/README.md), this carries only what a
plugin can uniquely declare. Everything else lives in the service and the
`clankie` launcher.

## What the plugin carries

| Piece                                                                                                                                                                                                    | File                       | What it does                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Output style `Clankie`                                                                                                                                                                                   | `output-styles/clankie.md` | His identity in place of the coding assistant's; forced on while the plugin is enabled. Generated from `instructions.md`.    |
| `SessionStart` hook                                                                                                                                                                                      | `hooks/hooks.json`         | `clankie prompt --lane operator --sections persona,reach,fleet,address,model`: the owner persona, reach, address, model card |
| `UserPromptSubmit` hook                                                                                                                                                                                  | `hooks/hooks.json`         | `clankie memory-card --lane operator`: the newest memory card, every turn                                                    |
| MCP server `clankie`                                                                                                                                                                                     | `.mcp.json`                | `clankie mcp --lane operator`: his tool bank over stdio, bearer read from the broker, never from a config file               |
| Skills `/clankie:this-machine`, `/clankie:trace-clankie`, `/clankie:lead`, `/clankie:swarm-lead`, `/clankie:herdr-lead`, `/clankie:swarm-mcp`, `/clankie:work-items`, `/clankie:computer-use-delegation` | `skills/`                  | Links to the shipped skills, available from any working directory                                                            |

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
development flag, so wakes and escalations reach the session. The launcher's
`--plugin-dir` path currently gets tools and skills without enabling wakes.
That is a launcher constraint, not a universal plugin-only channel requirement:
[an isolated probe](../../docs/testing/2026-09-26-interactive-swarm-workers/README.md)
on Claude Code 2.1.283 received events through a bare MCP server with the development
channel flag. That probe does not change the operator-seat launch path or establish
`--plugin-dir` channel support.

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
claude plugin details clankie          # output style, context/transcript hooks, one MCP server, eight skills
clankie seat --dry-run                 # "plugin": { "source": "installed" }, "channel": true
```

In the session, `/mcp` lists the `clankie` server, `/clankie:this-machine`
loads his install skill, and `clankie model status` runs without a prompt.

## Worker channel plugin (`clankie-worker`)

[`worker/`](worker/) is a second plugin in the same marketplace,
`clankie-worker@clankie`, for Swarm-dispatched **interactive** workers
([ADR 0194](../../docs/adr/0194-interactive-swarm-workers-receive-leased-channel-events.md)).
It is not the seat and carries none of the seat's identity, hooks, skills or
operator MCP. Its one MCP server, `swarm`, runs the Swarm MCP that the Herdr
launcher names in `SWARM_WORKER_MCP`, in channel mode, with the worker's own
enrolled capability; it refuses to start outside such a launch. The worker
launch enables it for that session only (`enabledPlugins`) and starts Claude
Code with `--channels plugin:clankie-worker@clankie`, so the worker's leased
Swarm mail arrives as channel events.

Claude Code only runs a non-official channel plugin unattended when the owner's
managed settings allow it. That is the owner's action, never the dispatcher's:
the exact `allowedChannelPlugins` entry and probe are in
[managed consent](../../docs/testing/2026-09-26-interactive-swarm-workers/managed-consent.md).
Install it disabled, like the seat:

```bash
claude plugin install clankie-worker@clankie
claude plugin disable clankie-worker@clankie
```

Select the mode per runtime with `clankie runtime mode ID interactive|stream`;
stream stays the default. An interactive startup that blocks stays visibly
blocked in its pane and never falls back to stream.

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

### Service restarts

The operator bridge renews its MCP session after an explicit `unknown_session`
rejection and retries that rejected request once. Concurrent requests share the
new session. Network failures and lost tool results are not replayed because the
tool may already have run. Persisted Herdr watches retain their stable terminal
identity when a wait process fails, retry observation, and resume on service start.
A failed wait is not treated as agent completion.

An already-running bridge must be reloaded once to pick up this implementation:
reconnect the plugin's **operator** MCP server (`clankie mcp --lane operator`),
not only the separate fleet mailbox (`clankie mcp --seat`).

The seat denies the inherited `linear-server` MCP connector, whose identity may
differ from the owner-connected account. That connected tracker identity is
Clankie’s and his whole swarm’s identity. Tracker writes use Clankie’s connected
tools or a granted worker bridge; a worker lacking access asks the lead to write. Follow Linear wakes the operator conversation
from that account's actual notifications; stored issue bindings do not route wakes.
