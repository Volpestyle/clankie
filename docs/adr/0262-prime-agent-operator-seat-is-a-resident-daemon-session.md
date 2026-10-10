# ADR 0262: Prime Agent's operator seat is a resident daemon session

Status: proposed for review (2026-10-10; VUH-1557).

Extends [ADR 0152](0152-a-harness-takes-the-operator-seat.md),
[ADR 0207](0207-work-records-and-native-agent-delivery.md) and
[ADR 0224](0224-grok-build-shares-the-visible-native-session.md).

## Context

Prime Agent 0.10 runs every session in a supervisor daemon behind one JSONL
socket (protocol 7). Its TUI is a client: `prime-agent attach <id>` opens the
real interactive view of an existing session, and exiting it detaches. The
daemon accepts session-plane commands without attaching. Prime has no
lifecycle hooks, and its model reaches MCP only from its Python REPL. Its
`send_message` arrives as a Prime agent message, which the model answers with
its own `agent_message`, so it is the wrong channel for Clankie's events.

## Decision

`clankie prime` creates (or, with `--resume`, re-finds) one resident daemon
session and runs `prime-agent attach` on it in the owner's terminal.

- Context: `create` carries the service persona and memory card in
  `appendSystemPrompt`, the shipped skills in `skills`, and this pane's
  `HERDR_*` variables so Prime's own Herdr reporter binds the pane. Owner
  configuration in `~/.prime/agent` is not edited.
- Tools: `replace_acp_mcp_servers` adds the `clankie mcp --lane operator`
  bridge under a fixed owner ID. The payload is Prime's worker shape
  (`type: "stdio"`, `cwd`, `env` as a map); the worker silently drops a list
  in the ACP wire shape. The bridge's parent is Prime's kernel, which also runs
  model code, so the parent check cannot authorize it; the seat passes the
  operator bearer explicitly, as the Grok seat does. Prime keeps the list in
  worker memory; same-session code can read it back.
- Delivery: each outbox event is fenced, then sent with the daemon's `prompt`
  to the recorded session after re-reading its session ID. Owner turns and
  escalations steer a running turn; wakes, watches and messages follow it. A
  failed send stays uncertain and is never resent. The TUI composer is never
  touched, so drafts survive.
- Projection: the Pi-format session file uploads to the selected conversation.
- Exit detaches. Nothing in Clankie stops, aborts or kills the session.

## Evidence and limits

Verified live on 2026-10-10 with `claude-haiku-4-5` in a Herdr pane: identity
and a memory-card fact from the service, 118 operator tools listed and
`runtime_update_status` called, two self-wakes delivered (receipts `started`),
an unsent draft kept across a wake, transcript turns in the service
conversation, detach leaving the session live, and `--resume` both
reattaching the live session and reopening its file after the worker was
killed. Busy-session steering and room escalations were not exercised. Prime
asks no tool approvals by default. A worker restart loses the MCP server until
`--resume` (read from Prime's source, not exercised). Versions other than 0.10.x and protocols other than 7 refuse.
