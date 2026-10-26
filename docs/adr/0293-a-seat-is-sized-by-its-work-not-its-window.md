# 0293: A seat is sized by its work, not its window

- Status: Accepted (lead, 2026-10-26, ratifying the budgets James requested)
- Work: VUH-2820 (VUH-2821 lead restart, VUH-2822 watch notices, VUH-2823
  context telemetry, VUH-2824 hired-seat restarts, VUH-2825 waits, VUH-2826
  ledger); follows VUH-2274
- Extends: [0271](0271-the-lead-seat-restarts-fresh-in-its-own-pane.md); amends
  the lead skill's "retire at 80% of the window" rule

## Context

A week of native transcripts (2026-10-18 to 10-25, both Claude accounts and
both Codex homes) shows that nearly all of the fleet's token volume is context
re-read on each call, not thinking or output. These are token counts; how they
weigh against each account's limits depends on per-model rates for cached
input, input and output, which this record does not measure.

- Claude seats read ~15.5B context tokens in ~40.9K model calls, 99% of them
  cache reads, almost all on Opus 5.5. Output was 22.6M tokens (0.15%).
  Codex seats added ~4.8B input tokens, almost all cached. Both Claude
  Max accounts were at 51% and 60% of their weekly limits with three days left.
- **The lead never restarted.** The global-default seat (`af163034`) ran from
  2026-10-06 and was resumed by `--resume` on 10-18. It compacted 38 times and
  spent ~4.1B tokens, 27% of all Claude use. ADR 0271's handoff request was
  never sent: the seat's input box border reads `── Clankie ─`, the draft
  check accepts only an unlabeled rule and returns `unknown`, and the restart
  loop drops that `draft_unknown` refusal silently every five minutes.
- **Rounds helped, context ate the gain.** VUH-2274's report and watch rounds cut
  the lead's turns from ~830 a day (10-13) to 300–540. Its median context per
  call rose from ~390K to 460–620K, so daily tokens barely moved.
- **Wakes that carry no decision.** The lead's tokens followed its wakes: worker
  reports (1,326 events, ~42%), service watches and rounds (752, ~34%), its own
  background tasks (~12%), self-wakes (~5%), the owner (~4%). Of 368 Herdr watch
  notices, 115 said the pane "settled" while still `working` with completion
  unverified; one PC pane produced 95. Many reports are relays between
  workers ("ready for Sage", "for Linden") or progress logs the work item
  already holds.
- **Workers run to the window.** 64% of worker tokens were spent in calls above
  400K of context; long sessions reach ~965K before Claude compacts them. The
  lead skill retires a seat at 80% of its window, which is 800K on a 1M window,
  and seat telemetry reports no context at all for Claude seats, so that rule
  never fires for the harness that carries nearly all the spend. The largest
  worker sessions carried 7 to 72 issue keys.
- **Waiting in the model loop.** Workers ran ~3,300 foreground `sleep`/`until`
  loops (~1.5B tokens, ~10%): tailing heavy-job logs, touching simulator leases
  (ten-minute idle timeout), and polling `clankie integrate status` after
  `--no-wait`. Each step re-reads the whole session.
- A fresh seat starts at ~50K tokens (lead and worker medians).

Outside evidence points the same way. Claude Code's own guidance says
performance degrades as the context fills and a fresh session with a better
prompt usually beats a long corrected one
([best practices](https://code.claude.com/docs/en/best-practices)); a message
to an idle session resends its full context
([costs](https://code.claude.com/docs/en/costs)); 1M-window models auto-compact
near 967K unless `autoCompactWindow` / `CLAUDE_CODE_AUTO_COMPACT_WINDOW` lowers
it, which Claude Code 2.1.310 supports
([model config](https://code.claude.com/docs/en/model-config)); and a background
command reports its own completion
([tools reference](https://code.claude.com/docs/en/tools-reference)).

## Decision

**Each seat's context is bounded by the work it holds, the lead wakes for
decisions rather than state, and nobody waits inside a model turn.** By
scope, models, effort, the 1M window, worker caps and the review gate do not
change: this record reduces how much context each seat carries and how often
it is re-read.

1. **Budgets are in tokens, and the service enforces them at clean boundaries.**
   - The default lead seat restarts fresh (ADR 0271) at **250K** tokens of
     context or **12 hours**, instead of 500K or 24 hours. From a ~50K start,
     that bounds its average call to roughly a third of today's.
   - Seat telemetry reports a Claude seat's context in tokens from its
     transcript, the same reading ADR 0271 uses, beside Codex's percent.
     `fleet_efficiency` flags a worker at **300K**; the lead decides whether
     to retire it, restart it fresh, or keep it with a reason.
   - At **450K** an idle hired seat is restarted fresh in its pane, with the
     ADR 0271 guards and handoff: the seat writes its brief, then a new session
     starts from its brief, its work item and its `.local/HANDOFF` note. This
     replaces Claude's own compaction near the window. `seatRestarts` (on by
     default) turns it off.
   - Claude seats launch with `autoCompactWindow` at **300K** for the lead and
     **500K** for hires, so a seat whose fresh restart is refused or still in a
     long turn compacts there instead of near 967K. Codex seats get the
     equivalent once its native limit is verified.
   - A seat holds one deliverable. After harvest it is tidied; the next
     unrelated issue goes to a fresh hire. The same seat continues only on the
     same patch or its review changes.
2. **A refused restart is visible.** Every refusal is recorded with its reason,
   count and last time, and `clankie fleet status` shows it. A seat over budget
   whose restart has been refused for two hours produces one owner-visible
   notice naming the reason. The draft check accepts a labeled border.
3. **The lead wakes for outcomes, blockers and decisions.**
   - A watch notice for a pane that settled still `working`, with unverified
     completion, is not a completion signal: it joins the next round, and a
     repeat for the same pane and state is dropped until the state changes. A
     gone pane, a failed or blocked turn, and a question still wake at once.
   - Workers keep progress on their work item, coordinate with peers through
     `message_peer`, and send the lead outcomes, blockers and decisions.
   - The lead hands multi-step reading and tracing to a background subagent,
     which starts small, as the lead skill already says.
4. **Waits happen outside the model.** Long `clankie heavy` runs, integration
   gates and other waits run as harness background tasks or blocking commands,
   and the seat continues on the completion notice. A simulator lease stays
   alive while its holder's native process is alive and either in a turn or
   holding or queued for a heavy permit; its idle timeout counts from the seat
   going idle at its prompt, so no seat touches a lease on a timer.
5. **The fleet measures what it spends.** A ledger read from native transcripts
   reports, per seat and per day: model calls, context tokens, median context,
   the share above budget and foreground sleep calls. It sits beside account
   usage (`clankie usage`). The before numbers are above.

## Success

Measured over a week against the numbers above, with output held level:

- Lead: median context per call at or under 250K; at least one fresh restart a
  day; tokens a day down by at least 60%.
- Workers: under 10% of tokens in calls above 400K; no foreground sleep loops.
- Fleet: Claude context tokens a week down by at least 50%.
- Output does not fall: issues closed with evidence, landed commits, review
  CHANGES rate, and owner-visible latency for urgent reports.

## Alternatives

- **Lower effort or smaller models.** Out of scope: the owner asked that
  nothing Clankie does now be weakened. Output is 0.15% of token volume, so
  effort is not where the volume is; whether another model would cost less
  against the account limits, or deliver less, is unmeasured. Roles can
  already name a model (`clankie agents role`), and any switch, such as
  Sonnet 5.5 for test triage, is a separate change measured on the ledger.
  A seat never switches model mid-session, which would rebuild its cache.
- **Compact earlier instead of restarting.** Compaction keeps one session and
  compounds its summaries. A fresh session from a self-written handoff and the
  shared record is what ADR 0271 chose for the lead, and the same reasons hold
  for workers.
- **Let the lead watch budgets by hand.** It cannot see a Claude seat's
  context today, and checking every seat each round costs the lead's own
  context. The service measures; the lead keeps the judgment calls between
  the flag and the backstop.
- **Fewer workers.** Parallel work is the product; idle context is the waste.

## Consequences

- A restart costs one handoff turn and a cold start of ~50K. Work in flight
  survives in the brief, the work item and the handoff note, the same
  protocol a retired seat already follows.
- Telemetry, refusals and the ledger make the budget auditable; a regression
  shows up as numbers, not as a surprise usage limit.
- Budgets assume today's 1M windows and Opus 5.5. They are constants of this
  record and change with evidence, not per seat.
