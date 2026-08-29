# Clankie herdr plugin

Clankie's UI surfaces inside [herdr](https://herdr.dev), declared through
herdr's plugin v1 manifest. Everything else about Clankie's herdr integration
is plain vanilla CLI and socket API — this plugin carries only what a plugin
can uniquely declare: panes, keybindable actions, and (in the future) event
hooks ([ADR 0139](../../docs/adr/0139-clankie-rides-vanilla-herdr.md)).

The plugin is optional: Clankie runs the same without it. Linking it puts his
board, console, and status report one keystroke from any herdr workspace.

## What you get

| Entry point           | Kind         | What it does                                             |
| --------------------- | ------------ | -------------------------------------------------------- |
| `board`               | pane (split) | The herdr-lead fleet board beside the current pane       |
| `console`             | pane (split) | The Clankie operator console (`clankie`)                 |
| `status`              | pane (popup) | Transient `clankie status` report over the current pane  |
| `clankie.board`       | action       | `herdr-lead split` — open the board where it wants to be |
| `clankie.focus-board` | action       | `herdr-lead focus` — jump to or back from the board      |

## Setup

Requirements: macOS (the manifest declares `platforms = ["macos"]`), herdr
0.7.3 or newer, and two commands on `PATH` — `clankie` (`pnpm cli:install`
symlinks it into `~/.local/bin`) and `herdr-lead` (the board CLI from the
`herdr-lead` skill).

Link this directory from the root of your checkout:

```bash
herdr plugin link "$PWD/integrations/herdr-plugin"
```

An installed release ships the same directory. `clankie doctor` reports
`herdrPlugin.bundlePath` when it is present; link that path instead of a
checkout.

herdr records an absolute path and loads plugins when the server starts, so
restart the herdr server after linking, and relink (`herdr plugin unlink
clankie`, then link again) if the checkout moves.

Then confirm it took:

```bash
pnpm doctor                                # the `herdr plugin` row says linked and enabled
herdr plugin list --plugin clankie         # registry entry and manifest path
herdr plugin action list --plugin clankie  # both actions registered
herdr plugin pane open --plugin clankie --entrypoint board
```

## Keybindings

herdr qualifies action ids as `clankie.<id>`. Bind them in
`~/.config/herdr/config.toml`:

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

Unbound actions still run from herdr's plugin menu or from the CLI:
`herdr plugin action invoke board --plugin clankie`.

## Troubleshooting

| Symptom                                      | Fix                                                                                             |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Nothing new in the plugin menu after linking | Restart the herdr server; plugins load at server start                                          |
| `herdr plugin list` shows it disabled        | `herdr plugin enable clankie`                                                                   |
| A pane opens and exits immediately           | `clankie` or `herdr-lead` is missing from `PATH`; read `herdr plugin log list --plugin clankie` |
| Panes drive the wrong checkout               | The registry holds an absolute `plugin_root`; unlink and relink from the checkout you want      |
