# ADR 0333: OpenCode 2 hires run a private server

Status: Accepted, 2026-11-01, for issue #168. Amends the OpenCode worker rule
"one native TUI, no second headless server" recorded in the
[OpenCode plugin README](../../integrations/opencode-plugin/README.md); builds on
[ADR 0203](0203-clankie-keeps-what-better-models-cannot-absorb.md) (no headless
agents) and [ADR 0207](0207-work-records-and-native-agent-delivery.md).

## Context

OpenCode 2 (2.0.0 on 2026-09-11; 2.2.5 on 2026-10-30) does not run V1
plugins, renames the `plugin` config key to `plugins` (local plugins are
directories), moves the server API to `@opencode/client`, and prints its
version as `opencode v2.2.5`. On a V2 install a Clankie OpenCode hire refused
before any brief: the version probe did not recognise that form.

In V1 the TUI hosted its server in-process, so "one native TUI, no second
server" held. In V2 every client, the TUI included, talks to a server process:
by default the owner's one shared background service
(`~/.local/state/opencode/service.json`), or with `--standalone` a private child
that the TUI starts and whose lease ends when the TUI exits. A worker needs
per-launch server plugins (the `clankie mcp --fleet` projection and the
disabled personal trackers). Those cannot be injected into the shared service
without changing it for every session the owner has open.

V2 also gives delivery Clankie lacked in V1: `POST /api/session/:id/prompt`
admits a message into the session inbox with `delivery: "steer"` (the next step
of the running turn) or `"queue"` (after it), and a client `id` makes a
repeated admission return the original item.

## Decision

- **The installed version picks the plugin.** A probed 2.x release takes the V2
  plugin (`integrations/opencode-plugin/v2/`, floor 2.2.5); 1.x keeps the V1
  plugin and floor 1.18.18. Linked Macs on OpenCode 2 refuse by name until the
  remote helper learns V2.
- **A V2 hire runs `opencode --standalone <cwd>`.** Its server is the TUI's own
  private child, started by OpenCode and gone with the TUI. Clankie still starts
  only the one native TUI in its Herdr pane and never a server of its own; the
  rule becomes "one native TUI and only the server it owns". Nothing types into
  the terminal.
- **The owner's database stays.** OpenCode 2 keeps provider credentials in it,
  so V2 hires get no dedicated profile and no registered SQLite history.
- **Delivery is the session inbox.** The plugin admits each message with
  `steer` or `queue` and a client message id in OpenCode's ascending form; the
  returned inbox item is the receipt. Hires advertise both modes. Uncertain
  admission is still never resent.

## Consequences

- Hires work on OpenCode 2 with steer and queue, real receipts,
  idle/working/blocked, settlement at OpenCode's idle marker, interrupt and
  exit, proven against the installed 2.2.5 TUI by
  `apps/clankie/test/opencode2-worker.integration.test.ts`.
- A V2 hire's session lives in the owner's database, so the owner can also see
  it from another OpenCode client. Opening it there runs it on the shared
  service while the hire's private server is alive; that is the owner's choice.
- Sessions the owner opened by hand live on the shared service. Reaching them
  through its prompt endpoint, and mapping a Herdr pane to the session it shows,
  is separate work under #168.
