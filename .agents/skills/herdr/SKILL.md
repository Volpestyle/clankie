---
name: herdr
description: "Control Herdr, a terminal multiplexer for coding agents. Use only when the user explicitly mentions Herdr or asks to use Herdr to inspect or control panes, tabs, workspaces, commands, or another agent. Do not use merely because a task could benefit from a background terminal, delegation, or parallel work. Requires HERDR_ENV=1."
---

# Herdr

The full skill is compiled into the `herdr` binary, so it always matches the
runtime this session talks to, including after Clankie updates Herdr. First
check that you are inside a Herdr-managed pane:

```bash
test "${HERDR_ENV:-}" = 1
```

If that fails, say you are not running inside Herdr and stop. Otherwise load the
skill and follow its output as this skill's instructions:

```bash
herdr --skill
```

Read it fresh each session; do not save its output over this file.
