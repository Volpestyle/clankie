# ADR 0208: Agents carry a role; the world reads it

Status: accepted (James, 2026-10-02). Applies
[ADR 0203](0203-clankie-keeps-what-better-models-cannot-absorb.md) and stays
inside [ADR 0188](0188-native-agent-chats-read-their-own-history.md).

## Context

The app's second version shows the swarm as a pixel world where agents work at
role stations. It needs three facts the host did not carry: what each agent is
for, whether it is fanning out into native subagents inside its own TUI, and
which work items belong at each station. The persona already had an
`appearance.accessory` with role-like names, but that field is cosmetic and
chosen for variety by a hash; a station cannot be keyed on it.

Under ADR 0203 this passes on both counts. The world is part of Clankie's
character, and neither Claude Code nor Codex gives the owner one view of a
mixed fleet's roles, fan-out and backlogs. Better models would not absorb it:
the facts belong to the owner's arrangement, not to any one harness.

## Decision

**A persona carries an optional semantic `role`:** `planner`, `designer`,
`builder`, `tester`, `reviewer` or `researcher`. Absent means unassigned. It
persists in the persona store with the character, survives seat moves, and is
independent of `appearance.accessory`. The owner sets it with the
`set_persona_role` operator op (steer grant), `clankie agents role`, or `/agents
role` in the TUI; Clankie or the owner can set it at hire time with the
optional `role` on `hire_agent` and `spawn_seat`. Nothing infers a role.
Custom roles are allowed (amendment below).

**A fleet seat may carry `subagents`:** a running count and up to eight recent
labels. It is derived from the harness's own transcript through
`@clankie/agent-transcript`. For Claude Code, an `Agent`/`Task` call with no
result is running; a background call answers at once with `async_launched` and
finishes when its `<task-notification>` lands in the parent journal; a
foreground call is treated as ended once the main thread speaks again in a new
message. The read is incremental, so a fleet read costs the append. A cold read
covers at most the last 2 MiB.

Codex is covered by the same reader and seat path (VUH-1531, 2026-10-04).
Its rollout header names the child's own `id`, `parent_thread_id`, nickname
and task path; `session_id` can name the parent. Discovery processes only
headers in the addressed parent's Codex home, then tails only direct children.
Labels combine nickname and task path. The parent journal's native
`FINAL_ANSWER` envelope, targeted wait/close results, and per-child
`list_agents` statuses settle children within that fleet read. A generic
`wait_agent` acknowledgement identifies no child and settles none. Successful
followup or a newer child `task_started` resets completion; interruption is
ended. When no current parent status exists, five minutes without a child file
write means done as a heuristic; a quiet running tool may be misclassified.
A current explicit running status takes precedence over idleness.

To respect ADR 0188, discovery alone never reads a transcript. The host reads
only seats it already has an address for: one it hired or whose chat the owner
opened. It reads only local seats. It stores nothing and imports no entries,
and the derived summary contains labels, not content. Absent means unknown,
not zero. Remote fleets are left absent because each read would cost an SSH
round trip per seat. The projection is bounded to 64 recent children per parent,
32 parent sessions, 4,096 recent rollout headers and 64 KiB per header. Older
children or parent completion records outside these windows are not guaranteed.

**A work item may carry `labels`** from its backend: Linear labels, GitHub
labels (minus the `status: …` labels the GitHub backend writes), or Markdown
`labels:` front matter. Listing accepts one `label` filter, matched
case-insensitively against any label. A station shows the items labelled with
its role. Labels are read-only through this contract. An owner labels work in
the tracker itself.

```mermaid
flowchart LR
  Owner[Owner: app, CLI, TUI] -->|set_persona_role| Persona[(Persona store: role)]
  Hire[hire_agent / spawn_seat role] --> Persona
  Fleet[fleet read] --> Persona
  Fleet -->|addressed local Claude/Codex seats only| Transcript[Native transcript: incremental tail]
  Transcript --> Subagents[seat.subagents]
  Station[Role station] -->|work_items label=role| Tracker[Linear / GitHub / Markdown labels]
```

## Alternatives

- Reuse `appearance.accessory`: it is cosmetic, hash-assigned and has a
  different vocabulary. Overloading it would turn every avatar edit into a
  reassignment.
- Push subagent state from Claude Code hooks: this would need new hook events,
  a service route and per-seat state, and it would cover only plugin-launched
  workers. The transcript already records the facts.
- Read subagents for every roster seat: this violates ADR 0188 for panes that
  are not working for Clankie.
- A separate role-to-backlog mapping: labels already exist in every tracker,
  and the role name is the label.

## Consequences

- The app places agents by `persona.role` and reads a station's backlog with
  `work_items { label: role }`.
- An unaddressed or remote seat shows no subagents. The world treats
  that as unknown.
- A Claude subagent started before the 2 MiB cold-read window is not counted.
  Codex children remain discoverable by header within the bounds above; parent
  completion outside the cold-read window falls back to child file idleness.

## Amendment: custom roles (James, 2026-10-02)

James asked for custom roles. The role is now an open, validated string. The six
built-ins stay as suggestions (`OPERATOR_AGENT_ROLES`). Any role is 1–24
letters, digits, spaces and hyphens, and starts with a letter or digit.

Parsing trims the role and collapses inner whitespace. A built-in in any casing
folds to its lowercase name. A custom role keeps the owner's casing for display
and compares case-insensitively (`operatorAgentRoleKey`), so `Sound Designer`
and `sound designer` are one role and one station. Personas stored with an
enum role remain valid, because every built-in is a valid string.

A read-only `roles` operator op lists roles as `{ role, builtIn, count }`. It
returns the six built-ins first, always and with counts, then the custom roles
personas hold, most held first. A custom role is labelled with the casing of
its most recently updated holder. `clankie agents roles` prints it. It is an op
rather than a fleet field so the long-polled snapshot does not grow. The app's
picker reads it on open.

A custom role's station reads work items labelled with that role, using the
same case-insensitive label match.
