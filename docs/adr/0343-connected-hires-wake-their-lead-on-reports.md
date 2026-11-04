# 0343. Connected hires wake their lead on reports

Status: accepted (2026-11-01). Amends [ADR 0336](0336-a-connected-app-wakes-a-lead-at-its-webhook.md). Amended by
[ADR 0355](0355-an-updates-outcome-reaches-its-lead.md).

A connected app may give `start_agent` a `notify: {lead, ref}` reference.
The hire retains it with the hiring device. A worker report or settled watch
wakes that named lead through its stored webhook with kind `worker_report`.
Only service-owned ids, event kinds and times enter the wake text, followed
by a hint to read the report with `read_reports {agent}`. Worker text stays
in the inbox. Connected `read_reports` reads are scoped to the authenticated
app's hires, newest first by default. Each report retains its hiring device
and optional reference; `agent` or `ref` selects a thread's own workers without
acknowledging anyone else's work. OAuth proves the app, not its individual
threads, so a thread must keep the agent ids or ref it used to hire. Legacy
reports with no hiring-app provenance remain in the operator inbox; the
service does not guess which app owns them.

Claude Code routine fire starts a fresh session; it cannot resume the Duet
thread that hired the worker. `read_reports` also accepts `waitSeconds` from
0 to 45, with `agent` or `ref` required for a positive wait. It returns existing
matching unread reports immediately, waits on durable report-change events
without polling, or returns empty at the deadline. Disconnect and shutdown
cancel the wait. Both relay HTTP hops allow 55 seconds, within the MCP call's
60-second default timeout. Acknowledgment remains explicit and unchanged.

The first event sends immediately. Further events within 120 seconds batch
at the window's end, with a new window after each send. Failed notifications
are logged and never prevent inbox delivery. Notifications are best effort;
the inbox remains the durable record. Anthropic routine webhooks receive
`anthropic-version: 2026-10-21`.
