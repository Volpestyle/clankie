# ADR 0261: Hires go where capacity would otherwise go unused

Status: accepted by the lead for VUH-1974, 2026-10-09.
Tracked by [VUH-1974](https://linear.app/vuhlp/issue/VUH-1974).
Builds on [ADR 0260](0260-usage-meters-come-from-each-harness.md).

## Context

`worker_accounts` reported `headroom`, one minus the tightest all-model
window's percent used, and automatic hires took the account with the most.
On 2026-10-09 that misled three ways: it ignored plan size (16% of a Max 20x
week is more than most of a 5x week), it ignored pace against reset (84% used
with 4.7 days left is on course to run out in hours, and Codex Pro ran out in
2.3 days that week without warning), and it never said why it chose.

## Decision

Each machine's report carries an `allocation`. For every Claude and Codex
account that is usable and not held, spare capacity per day is

    planWeight × min over all-model windows of (left ÷ days to reset − used per day)

- **Plan weight** is relative to each harness's base paid plan: Claude Pro 0.2,
  Max 5x 1, Max 20x 4; Codex Plus 1, Pro 6. Claude's tier comes from the
  rate-limit tier Claude Code caches in the profile's `.claude.json`, used only
  when that cache names the same email `claude auth status` reports. An
  unreported tier counts as 1 and the reason says so; it is never guessed.
- **Pace** is the window's own average, percent used over the time the window
  has run, once 5% of it has passed. No history is kept.
- **Model-scoped windows** (Codex's gpt-reserve, Claude's per-model weeks) bound
  only hires on that model, so they are named in the reason and warned on, but
  do not rank.
- **Unknown usage** ranks after every reading.

High spare is capacity that goes unused at reset unless someone hires on it,
so it ranks first; negative spare is an account on pace to run out before its
reset. A hire that names no account takes rank 1 and its result's
`accountChoice` states the harness, account and reason. Explicit accounts
(request, role or fleet) and owner holds always win. A harness-less hire
avoids a harness whose best account is on pace to run out.

The lead hears a projected run-out once: each fleet round with led seats reads
this Mac's accounts, and a weekly window on pace to run out at least
`usage.runOutWarningHours` (default 12) before its reset wakes each lead once
per window reset, with where the next hires should go. Nothing moves or stops
a live seat on its own.

A signed-in Claude profile whose first-run setup is unfinished is not usable:
a hire there stalls at the theme, security and trust screens.

## Consequences

- The same ranking reaches the API (`GET /v1/usage`, `GET /v1/worker-accounts`),
  the CLI (`clankie usage`), the console, and MCP (`worker_accounts`).
- The weights are coarse vendor ratios, not measured quotas. Codex's Pro
  multiple in particular is an estimate and should be revisited if Codex
  publishes per-plan limits.
- Remote machines get the ranking for hires, but run-out warnings read only
  this Mac until linked machines' seats need them.
- The warned set lives in memory, so a service restart can repeat one warning.
