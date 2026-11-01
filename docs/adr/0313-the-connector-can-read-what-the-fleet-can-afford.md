# ADR 0313: The connector can read what the fleet can afford

Status: Accepted by James, 2026-10-31. Amends
[ADR 0301](0301-claude-reaches-the-fleet-through-a-narrow-connector.md).
Amended by [ADR 0324](0324-a-lead-reads-how-fast-the-fleet-spends.md), which
adds each account's burn rate.

## Context

A connected lead app can hire, but it cannot see whether the fleet can afford
the hire. Clankie already records that in pieces: Claude and Codex account
plans and usage windows, Prime's transcript spend, the lead and worker review
budgets used for cost evidence, each actor's tracker request budget, heavy-work
permits, and a live pane's context occupancy when a transcript has reported it.
None of that was on the connector. A lead that guessed a limit from a missing
field would hire on a number Clankie does not have.

## Decision

- **`fleet_capacity` is a read-only connector tool.** It hires nothing and
  changes nothing. It returns, per machine and per account Clankie already
  meters, the plan or tier, usage so far, the remaining fraction, and the reset
  time. It also returns heavy-work permit counts, each actor's tracker request
  budget, and each live pane's context occupancy. The pane id is the same one
  `list_agents` uses.
- **Unknown stays unknown.** A figure the source does not carry is the string
  `"unknown"`. The tool does not fill a model's context window from the 300K
  review heuristic, and it does not assign the worker review budget to a pane
  whose role is unknown. The review budget is 250,000 tokens for the lead pane
  and 300,000 for a hired worker, the same constants cost evidence uses, and
  only when that role is known. `contextPercentOfWindow` is present only when
  the harness recorded a window. Account reads are reused for a minute, the
  same way the usage meter avoids spawning every profile's CLI on each poll.
- **No secrets.** Homes, emails, account keys, ChatGPT account ids, credential
  material, process ids and executable paths are not copied, even when the
  source record has them. A harness Clankie does not meter is absent. A live
  pane of that harness, Grok included, is listed with unknown account and
  unknown context when nothing was recorded.
- **Herdr detection still hides panes.** With detection off, the tool returns
  accounts, permits and budgets, and an empty pane list that says detection is
  off. An app the owner turned off is refused, as with every other connector
  tool.

## Consequences

- A lead can decide whether to hire from numbers Clankie already has. Where he
  has none, the answer says so.
- The historical transcript scan that builds cost-evidence totals is not run
  here. That scan assigns the worker review budget to sessions whose role is
  unknown, which this read refuses to repeat.
- Wake routing is unchanged.
