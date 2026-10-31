# Clankie herdr plugin

Clankie's UI surfaces inside [herdr](https://herdr.dev), declared through
herdr's plugin v1 manifest. Everything else about Clankie's herdr integration
is plain vanilla CLI and socket API — this plugin carries only what a plugin
can uniquely declare: panes, keybindable actions, and (in the future) event
hooks ([ADR 0139](../../docs/adr/0139-clankie-rides-vanilla-herdr.md)).

The plugin is optional: Clankie runs the same without it. Linking it puts his
board, console, and status report one keystroke from any herdr workspace.

## Hand-started Claude on Mac

In prepared Mac zsh panes, typing `claude` or `claude --resume ID` selects
Clankie's PATH shim, which loads Clankie's worker for that session (ADR 0314):
`--plugin-dir` with this install's `integrations/claude-plugin/worker` and
`--channels plugin:clankie-worker@inline`, and switches off an older installed
copy for that launch. A settings layer that sets `clankie-worker@inline` (or the
older `clankie-worker@clankie`) to `false` opts out. The shim is independent of the optional UI plugin.
Bundled zsh panes are prepared at service start. For the active linked local
Herdr session:

```sh
clankie herdr prepare local --claude-path-shim install
```

Open a new pane afterward. The command writes a stable Clankie-owned launcher
under `~/.clankie/herdr-pane/SESSION`, sets only `[terminal].default_shell`,
and reloads Herdr's config for future panes. A config symlink stays linked;
the edit goes to its canonical source. Preparation is idempotent. The launcher
sources the owner's zsh startup files, preserving their `ZDOTDIR`, and puts
the shim first on PATH after startup. It does not edit shell dotfiles.
Existing custom shell launchers are refused rather than replaced.

Undo the shell selection with:

```sh
clankie herdr prepare local --claude-path-shim remove
```

Removal restores the saved config exactly when unchanged, or restores only the
prior shell setting while preserving later owner edits. It refuses if another
launcher has taken over. It leaves the generated files and existing panes alone.

Explicit `--channels` (including `--channels=...`) always wins. Print,
administrative and bare launches, nested Claude processes, and launches with
explicit `--settings` or `--setting-sources` pass through. The shim checks
the selected `CLAUDE_CONFIG_DIR` at every launch and respects project/local
plugin disabling. Outside the selected managed Herdr session it passes through.
It skips every installed copy/symlink of itself when resolving real Claude,
and replaces its process so Claude keeps normal TTY, signals and exit status.
Project proof uses the same lookup on the service's absolute PATH entries,
so an inherited pane shim does not hide the installed Claude executable.
Admission still requires fresh kernel process identity and caller membership.

`clankie doctor` reports `herdrPlugin.claudePathShim`: `active` describes this
pane's PATH, `configured-for-new-panes` describes the saved shell selection,
and `unverified` means the service's selected local session could not be read.
Those are setup observations; only an exact-session live channel poll proves a
receiver. Aliases/functions and absolute Claude paths can bypass PATH. Channel
policy, plugin trust and worker membership still apply. No running Claude gains
channels from installing the shim.

Automatic activation currently supports Mac zsh. Linked Windows PowerShell and
Git Bash activation and idle-wake proof are tracked in
[VUH-2084](https://linear.app/vuhlp/issue/VUH-2084).

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
separately installed dashboard; it is no longer bundled with `lead`).

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
