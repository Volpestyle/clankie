# 0355. An update's outcome reaches its lead

Status: Proposed, 2026-11-03, for #735. Amends [ADR 0343](0343-connected-hires-wake-their-lead-on-reports.md).

A connected lead could lose worker and update results with nothing saying so
([#735](https://github.com/Volpestyle/clankie/issues/735)). A hire named a lead
with no stored webhook and every wake ended quietly. A passed canary and a
confirmed rollback told nobody, and a failed canary's alert went to a conversation
that is held while apps lead.

A hire's `notify.lead` must have a stored webhook, or `start_agent` refuses with
`unknown_lead` and the names that do, as `post_note` refuses. A wake that fails
later is a logged warning, and `list_agents` and `read_reports` show the hire's
`notify` state. A report wake has no further fallback: the report is already
durable in the inbox, and Clankie's lead lane would only repeat what that thread
holds.

`clankie update --notify LEAD` wakes that lead with the outcome. While apps lead,
every stored lead hears every outcome, including updates nobody named a lead for.
Outcomes are `passed`, `failed`, `rolled-back` and `extended` (a canary extended
under machine pressure). An update refused after acceptance wakes only a lead
that was named, since scheduled installs are refused routinely. The conversation
alerts stay. An outcome wake that nobody takes falls back to Clankie's own
conversation, as a board note's chain ends in his lane.

An outcome wake has kind `update_outcome` and carries only service-owned facts:
operation id, outcome, commits and reason code. Webhooks leave the Mac, so error
text, which can hold local paths, stays in `clankie update status`. A claim file
beside the operation sends each outcome once and never replays an uncertain one.
Wakes run from canary ticks, not recovery, so a slow webhook can't hold boot.

Start receipts persist in `connector-starts.json` without their briefs. A start
that a restart cut off answers from the hire records, and nothing is replayed.
