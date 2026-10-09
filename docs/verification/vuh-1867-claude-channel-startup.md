# VUH-1867: hand-started Claude channel startup fix

James authorized automatic channel setup if supported, otherwise a one-step
startup fix, with live proof in an owned throwaway Mac pane. The implementing
lead chose the fallback after reading the [official channel controls](https://code.claude.com/docs/en/channels#enterprise-controls):
users must opt a server into each session with `--channels`; installation and
managed `channelsEnabled`/`allowedChannelPlugins` only make it available. The
[SessionStart hook](https://code.claude.com/docs/en/hooks#sessionstart) supplies
context and user-visible JSON `systemMessage`, not changes to launch argv.
`CLAUDE_ENV_FILE` sets environment for later Bash commands, not the already
selected session channel. No supported plugin-only automatic opt-in was found.

The hook now shows:

```text
Clankie's live messages are off in this pane. Restart this session with:
claude --resume SESSION_UUID --channels plugin:clankie-worker@clankie
```

It uses a validated native UUID and the matching fleet descriptor. The warning
runs before the lifecycle HTTP report, so a refused report cannot suppress it.
Process ancestry handles intermediary command shells; unavailable ancestry
uses “cannot confirm” wording. Exact normal/development plugin opt-in suppresses
the warning. Development opt-in still requires Claude's interactive native
confirmation and organization policy; the hook does not bypass either.

## Checks

Sixteen real command-hook subprocess cases use an actual intermediary shell,
recorded native argv, a private Herdr socket fixture and a loopback lifecycle
listener. They cover exact resume output, normal/equals/multiple/development
flags, different plugins, refused reporting, unlinked/missing/ambiguous panes,
non-startup/Codex/print contexts, unsafe IDs and unavailable launch observation.
The existing three permission command-hook cases also pass (19 tests across
the two files). The five-file `test:seat-delivery` gate passes all 86 tests,
including exact/lost/missing-ID/wrong-ID ACK cases with the shared launch parser.
The heavy TUI typecheck and scoped formatting, lint and documentation link checks
pass. No repository-wide suite, eval or deployment ran.

## Native Mac proof

At 02:58:21 UTC on 2026-10-09, Claude Code 2.1.295 in the owned throwaway pane
`w47:pG` displayed:

```text
SessionStart:startup says: Clankie's live messages are off in this pane.
Restart this session with: claude --resume 3c343503-c3fc-4074-9fd6-5250b471d51b --channels plugin:clankie-worker@clankie
```

The native process had no channel flag. Instrumentation selected the checkout
SessionStart hook and explicit session UUID through a temporary settings file,
with an isolated loopback lifecycle listener. The actual hook reported that
same session before proof was captured. No prompt or brief was typed or sent.
This proves the live user-visible startup fallback, not a deployed installed
plugin or Windows execution. The own child was stopped afterward, releasing its
heavy permit. Raw ignored evidence is in `.local/claude-proof/startup-runtime/`
(`evidence.jsonl`, `native-startup.txt`, `debug.log`).

PC live execution remains untested under James's explicit Mac-only proof and
no-PC-input boundaries. Existing panes, dotfiles and the installed captain were
untouched. The channel wake behavior itself has separate owned native proof in
[VUH-1870](vuh-1870-claude-delivery.md) and [VUH-1868](vuh-1868-claude-workers.md).
