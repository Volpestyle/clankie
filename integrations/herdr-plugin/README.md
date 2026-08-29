# Clankie herdr plugin

Clankie's UI surfaces inside [herdr](https://github.com/ogulcancelik/herdr),
declared through herdr's plugin v1 manifest. Everything else about Clankie's
herdr integration is plain vanilla CLI and socket API — this plugin carries
only what a plugin can uniquely declare: panes, keybindable actions, and (in
the future) event hooks
([ADR 0139](../../docs/adr/0139-clankie-rides-vanilla-herdr.md)).

## Entry points

| Entrypoint            | Kind         | What it does                                             |
| --------------------- | ------------ | -------------------------------------------------------- |
| `board`               | pane (split) | The herdr-lead fleet board beside the current pane       |
| `console`             | pane (split) | The Clankie operator console (`clankie`)                 |
| `status`              | pane (popup) | Transient `clankie status` report over the current pane  |
| `clankie.board`       | action       | `herdr-lead split` — open the board where it wants to be |
| `clankie.focus-board` | action       | `herdr-lead focus` — jump to or back from the board      |

## Install

The plugin is repo-owned; link the working directory:

```bash
herdr plugin link ~/dev/clankie/integrations/herdr-plugin
herdr plugin action list --plugin clankie
herdr plugin pane open --plugin clankie --entrypoint board
```

Requirements on `PATH`: `clankie` (`pnpm cli:install`) and `herdr-lead`
(symlinked from the skills repo).

Suggested keybindings for the herdr config:

```toml
[[keys.command]]
key = "prefix+b"
type = "plugin_action"
command = "clankie.board"
description = "herdr-lead board"

[[keys.command]]
key = "prefix+shift+b"
type = "plugin_action"
command = "clankie.focus-board"
description = "jump to/from the board"
```
