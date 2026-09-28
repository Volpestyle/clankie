# herdr-lead: one-time install

One-time install, from the skill's real directory
(`readlink ~/.claude/skills/herdr-lead`, currently
`~/dev/skills/agent/herdr-lead`), not the symlink:

```bash
pnpm install --dir plugin                       # pi-tui; the board will not start without it
chmod +x plugin/cli.ts && ln -sfn "$PWD/plugin/cli.ts" ~/.local/bin/herdr-lead
herdr plugin link "$PWD/plugin"                 # registers the open/focus actions
```

Linking registers the action but binds no key. Add one to `config.toml` — and
note `prefix+shift+l` ships as `swap_pane_right`, so it must be moved or the
custom command is silently disabled (herdr keeps the built-in on a conflict):

```toml
[keys]
swap_pane_right = "prefix+>"    # same physical key, spelled as the shifted char

[[keys.command]]
key = "prefix+shift+l"
type = "plugin_action"
command = "herd-lead.focus"
description = "jump to / from herd lead board"
```

Spell shifted punctuation as the shifted character (`prefix+>`), never
`prefix+shift+.` — the latter parses but never fires, since the terminal sends
`>` and the matcher only bridges the two when the config names the shifted char.
`herdr config check` reports conflicts and unparseable keys; `herdr server
reload-config` prints the diagnostics that a silent disable would otherwise hide.

Symlinking the skill into `~/.claude/skills/herdr-lead` is what makes both
`/herdr-lead` and the `~/.claude/skills/...` paths below resolve — the plugin
works without it, the skill does not. After moving the plugin or editing the
keybinding, run `herdr server reload-config` — herdr reads `config.toml` once at
startup, so a stale path makes the keybinding fail silently.
