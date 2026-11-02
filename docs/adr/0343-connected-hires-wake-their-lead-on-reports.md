# 0343. Connected hires wake their lead on reports

Status: accepted (2026-11-01). Amends [ADR 0336](0336-a-connected-app-wakes-a-lead-at-its-own-webhook.md).

A connected app may give `start_agent` a `notify: {lead, ref}` reference.
The hire retains it with the hiring device. A worker report or settled watch
wakes that named lead through its stored webhook with kind `worker_report`.
Only service-owned ids, event kinds and times enter the wake text, followed
by a hint to read the report with `read_reports {agent}`. Worker text stays
in the inbox, where agent filtering and optional newest-first reads let the
hiring thread find its reports without acknowledging another worker's work.

The first event sends immediately. Further events within 120 seconds batch
at the window's end, with a new window after each send. Failed notifications
are logged and never prevent inbox delivery. Notifications are best effort;
the inbox remains the durable record. Anthropic routine webhooks receive
`anthropic-version: 2026-10-21`.
