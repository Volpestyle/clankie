# ADR 0324: A lead reads how fast the fleet spends

Status: Proposed, 2026-11-01. James asked for it on 2026-11-01 ("its important
to gauge usage allocation with workers using clankie mcp to know our rate of
ussage"). Amends [ADR 0313](0313-the-connector-can-read-what-the-fleet-can-afford.md).

## Context

`fleet_capacity` tells a connected lead how much of each account's usage window
is used and when it resets. It does not say how fast it is being used, so a
lead pacing a push toward a reset cannot tell whether the fleet will run out
first or leave capacity unused. Clankie already computes a window's average
pace for hire allocation (`usageWindowPace`), but an average over a week hides
an afternoon of ten parallel workers. The connector also cannot trace the pace
to the agents spending it: panes carry context occupancy, which is not spend.

## Decision

- **Clankie keeps his own usage readings.** Every worker-account read he
  already makes (hires, auto-staffing, the usage meter, `fleet_capacity`) is a
  sample, kept per account window in `usage-history.json` in his state
  directory for eight days. A reading is kept when it moved or five minutes
  have passed. He also reads this Mac's Claude and Codex accounts every ten
  minutes, so readings exist when no one asked; `claude -p /usage` and Codex's
  rate-limit read spend no model tokens. Only labels, window ids, percents and
  times are stored.
- **`fleet_capacity` gains `burn`.** One row per Claude or Codex account with a
  reading, however many machines report it. Each usage window carries percent
  per hour three ways: `recent`, the change since Clankie's oldest reading of
  the same window between half an hour and three hours earlier; the window's
  own `windowAverage`; and `toUseAllByReset`, the even pace that spends what is
  left exactly at reset. It projects the percent used at reset, at the recent
  pace when known and otherwise the average, and says when the window runs out
  if that comes first. A pace Clankie cannot measure is `"unknown"`.
- **The last hour per session.** For each Claude account signed in on this
  Mac, the row sums the last hour of every local session's transcript, its
  subagents included: input, output, cache-write and cache-read tokens, each
  native message once. A session that is a seat Clankie knows is named by the
  agent id `list_agents` returns; any other session is counted and left
  unnamed. Session ids, homes, project paths and message text are not in the
  answer. Linked machines' transcripts and Codex sessions are not read here;
  their accounts still carry window rates.
- **Read only.** The tool still hires and changes nothing.

## Consequences

- A lead can compare each window's recent pace with `toUseAllByReset`: below
  it, capacity goes unused at reset; above it, `runsOutAt` says how long the
  current pace lasts.
- The recent pace needs readings half an hour apart, so it is unknown for the
  first half hour after an update and after a long sleep.
- Percents are whole numbers as the harnesses report them, so a slow recent
  pace reads in steps. Token counts are raw; the vendors weigh them into the
  window percent in their own way.
