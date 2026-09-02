# Clankie Claude Code plugin

Clankie's operator seat as a Claude Code plugin
([ADR 0152](../../docs/adr/0152-a-harness-takes-the-operator-seat.md)). Sit in
Claude Code on your own plan and you are talking to Clankie: his identity, the
owner persona, his tools over MCP, the newest memory card on every turn, and
his skills. The service keeps running his body, Discord, voice, and play.

Like the [herdr plugin](../herdr-plugin/README.md), this carries only what a
plugin can uniquely declare. Everything else lives in the service and the
`clankie` launcher.

## What the plugin carries

| Piece                                                    | File                       | What it does                                                                                                              |
| -------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Output style `Clankie`                                   | `output-styles/clankie.md` | His identity in place of the coding assistant's; forced on while the plugin is enabled. Generated from `instructions.md`. |
| `SessionStart` hook                                      | `hooks/hooks.json`         | `clankie prompt --lane operator --sections persona,reach,address,model`: the owner persona, reach, address, model card    |
| `UserPromptSubmit` hook                                  | `hooks/hooks.json`         | `clankie memory-card --lane operator`: the newest memory card, every turn                                                 |
| MCP server `clankie`                                     | `.mcp.json`                | `clankie mcp --lane operator`: his tool bank over stdio, bearer read from the broker, never from a config file            |
| Skills `/clankie:this-machine`, `/clankie:trace-clankie` | `skills/`                  | Symlinks into `.agents/skills`, so they load from any working directory and stay repo-owned                               |

The output style is generated: edit `apps/clankie/src/captain/instructions.md`
and run `node integrations/claude-plugin/build.mjs`. `node
integrations/claude-plugin/build.mjs --check` fails when the file is stale, and
the launcher's tests run that check.

## Launch

```bash
clankie seat              # sit down; a checkout loads this directory with --plugin-dir
clankie seat --resume     # reopen the last seat's conversation
clankie seat --dry-run    # print the launch plan as JSON without starting Claude Code
```

`clankie seat` needs Claude Code on `PATH` and a TTY. It passes the permission
allowlist for `clankie` commands (`--settings`), names the herdr pane `clankie`
when it is one, and starts Claude Code with `--name Clankie`. With the plugin
installed from the repo's marketplace it also passes the channel development
flag, so wakes and escalations reach the session; a `--plugin-dir` seat gets
his tools and skills but not his wakes, because the channel preview accepts
only marketplace-installed plugins.

Install from a checkout or an installed release (`clankie doctor` names
`repoRoot`):

```bash
claude plugin marketplace add "$PWD/integrations/claude-plugin"
claude plugin install clankie@clankie
```

Then confirm it took:

```bash
claude plugin details clankie          # output style, two hooks, one MCP server, two skills
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
| He answers as Claude Code                  | The output style is not applied: `claude plugin list` must show `clankie@clankie` enabled  |
| `/mcp` shows `clankie` failed              | The service is down or the operator credential is missing: `clankie status`                |
| No persona or memory card at session start | `clankie` is not on the hook's `PATH`; `pnpm cli:install` symlinks it into `~/.local/bin`  |
| Wakes never arrive                         | The seat was loaded with `--plugin-dir`; install from the marketplace for the channel flag |
| `claude plugin validate --strict` warns    | The two skills are symlinks by design; sessions follow them, validation does not           |
