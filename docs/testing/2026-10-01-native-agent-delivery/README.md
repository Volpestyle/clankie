# Native agent delivery and optional Swarm

Decision: [ADR 0207](../../adr/0207-work-records-and-native-agent-delivery.md).
Source changes were verified on Windows using Node 24.21.0. No running fleet or
installed settings were changed, and no live terminal-draft test was performed.

## Verified behavior

- Briefed hires without a structured adapter fail before creating a pane.
  Missing channel consent never causes a terminal-input fallback.
- A chosen delivery path is attempted once. Uncertain startup retains the pane;
  uncertain messages are not retried through another channel or terminal.
- Taken-but-unacknowledged mailbox events remain `unconfirmed`, including abort
  and close paths. Claude checks the native transcript; Codex reports `steered`
  when it uses `turn/steer`.
- Tools, operator DMs, room notices, and the TUI distinguish unavailable control
  from uncertain delivery. The TUI retains the prompt without replacing a newer
  draft or automatically sending again.
- Swarm startup is selectable through the API, CLI, and Connections menu. The
  default remains enabled for compatibility. Saving a different selection reports
  restart required and preserves connections, credentials, and task records.
- Native MCP tools and work tracking remain usable with Swarm absent or disconnected.

## Checks

The integrated run passed **255 tests in 20 suites**, covering the Claude/Codex
adapters, mailbox and fleet delivery, hire/resume, captain messages, operator
DMs/rooms, TUI delivery, Swarm configuration/connections, and protocol boundaries.
After the final room-notice correction, the selected room, disabled-MCP, and Swarm
settings checks passed **27 tests** (43 unrelated tests excluded by the filter).
After splitting delivery failures into literal protocol discriminants, the
operator DM, TUI, and protocol suites passed **67 tests**. These runs overlap;
their counts are not additive.

Settings, protocol, and TUI typechecks passed. Both native instruction projections
were regenerated and their `build.mjs --check` checks passed. The Codex snapshot
builder now resolves authored root skill symlinks before copying, avoiding a
Windows directory-link error without replacing those links.

The full service typecheck remains blocked by the checkout's missing
`@browser_use/pi` dependency (and dependent browser types) and a pre-existing
`CoordinationClient.connected` mismatch in the concurrently edited Swarm source.
Scoped source lint and whitespace checks passed.

Full `pnpm check` was attempted with Node 24 and stops at the pre-existing Herdr
installer error `No official Herdr asset for this platform`. Initial documentation
checks also exposed Windows path and CRLF handling bugs. The documentation
follow-up fixed those in the existing checker and builder: `pnpm docs:check` now
passes for **320 Markdown files and 10 generated public pages**, including their
links and anchors. This does not establish a full repository check pass.

## Harness capability evidence

This source review identifies possible integrations, not five implemented or
live-verified Clankie adapters.

| Harness     | Same-session mechanism                                              | Evidence and limit                                                                                                                                                                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | Channel loaded in the native process                                | [Official channel reference](https://code.claude.com/docs/en/channels-reference). Busy events wait for a turn boundary; notification delivery alone does not acknowledge processing.                                                                                                                                                   |
| Codex       | Native TUI and controller share an app-server and bound thread      | [Official app-server documentation](https://learn.chatgpt.com/docs/app-server). `turn/steer` addresses active work; `turn/start` starts a turn.                                                                                                                                                                                        |
| Pi          | Native extension calls `sendUserMessage` with `followUp` or `steer` | [Upstream example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/send-user-message.ts). A standalone headless RPC process is a different session. No local hire adapter was added.                                                                                                          |
| OpenCode    | Session endpoint on the existing TUI's HTTP server                  | [Official server documentation](https://opencode.ai/docs/server/). Starting another server or using composer append/submit endpoints does not establish safe control of the existing session. No adapter was added.                                                                                                                    |
| Prime Agent | Daemon routes `prime-agent send` to the active session              | Assuming PrimeIntellect's CLI: [command source](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/crates/pa-cli/src/daemon_command.rs) and [TUI client](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/crates/pa-tui/src/daemon_client.rs). Source evidence only; no adapter or installed-version test was added. |

## Remaining limits

Codex control is currently held in memory. A saved session reference alone does
not reattach it after a service restart. Sends remain bound to the original
thread if the owner changes the thread displayed in the native TUI; the current
server interface does not expose an atomic check of the client's displayed thread.

Claude's mailbox remains keyed by terminal identity. Its adapter checks the
session before delivery, but there is no strict session-generation fence over
the entire asynchronous mailbox operation. Existing native channel draft/busy
evidence is in the [September 26 probe](../2026-09-26-interactive-swarm-workers/README.md);
the [September 30 local worker run](../2026-09-30-claude-worker-seat/README.md)
used the former terminal fallback and does not prove the new channel path live.
Existing Codex same-thread and owner-interaction evidence is in the
[app-server probe](../2026-09-30-codex-app-server/README.md).

Operator DMs add `seat_undelivered` and `seat_delivery_unconfirmed` protocol
results. The public TUI handles them. The private app checkout was unavailable in
this workspace, so its adoption of the updated shared protocol was not verified.
