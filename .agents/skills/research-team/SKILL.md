---
name: research-team
description: >-
  Lead or advise an agent research effort across all its activities: connect
  evidence from tasks, decisions and experiments, challenge the approach, find
  overlooked opportunities, and establish what results actually support. Use
  for research strategy and execution, including model training, data work,
  engineering and coordination. Builds on `lead` for team execution.
---

# Research team

Hold both questions: are the results trustworthy, and are we pursuing the right
approach? A model can score well on the wrong data; a careful experiment can
answer a question that no longer matters; a well-executed task can serve the
wrong priority. Research leadership considers the whole effort, connects its
activities to the person's goal and changes direction when the evidence warrants it.

For authorized dispatch, load `lead`. Local and remote hires use `hire_agent` and `message_seat`; remote seat IDs
retain their fleet prefix. Workers report with `message_clankie` to the hiring
or adopting conversation. Native Codex children remain part of their parent
seat; use them for bounded analysis when available. Workers can resolve a
shared boundary with `list_fleet_seats` / `message_peer` while peer messages
are enabled, without transferring scope or waking the lead. Missing
harness control never permits automated terminal typing. Use `work-items` when
a tracker is in play and `shared-checkout`
before commits. An advisory check-in does not itself authorize more workers,
compute, data access or external actions.

## Roles

- **Lead: the principal investigator.** Owns the question, budget, dispatch
  and acceptance. Integrates findings and explains decisions to the person.
  Keep one accountable operations owner; direct analysis is useful when it
  resolves a bottleneck without competing with an existing lane.
- **Research advisor.** Holds a view across all activities, tasks, decisions
  and experiments, across lanes and over time. Looks for patterns, missing
  assumptions, neglected alternatives and clues the team has explained away
  in strategy, engineering, data, tooling, coordination and resource use.
  Challenges the lead's framing and its own earlier recommendations. Use the
  strongest reasoning model available within
  the person's model and budget choices, at its highest supported reasoning
  effort. Verify the effective model and effort when assigning this role.
  This is a function the lead can perform or the person can assign separately;
  it does not require another agent or approval layer. Route direction changes
  through the accountable lead.
- **Lane owners.** Own a bounded outcome through prerequisites, evidence and
  its next usable result, with named files and explicit handoffs. Keep their
  lane notes under one writer while that ownership holds.
- **Reviewers.** When independent review is warranted, use someone outside
  the authoring lane, preferably with a different model family or perspective.
  The lead checks findings before sending fixes back to the owner. Author tests
  are evidence, not independent review; follow the project's review rules.
- **The person.** Owns the goal, domain judgment, tradeoffs and funding.
  Bring consequential decisions and results, and check their assumptions too.

## Research judgment

Go beyond the latest status. Read enough of the accumulated evidence to notice
what the team is missing, without replaying every audit at every check-in.

- **Connect patterns across the work.** Repeated rework, stalled handoffs,
  infrastructure faults, successes confined to one slice and unexplained
  contradictions can point to a shared cause. A clue in one task may explain
  a problem or reveal an opportunity elsewhere. Distinguish observations from
  interpretations: overfitting does not uniquely prove too little data, and
  a failed run is not a failed model.
- **Question the formulation.** Does this activity advance the person's goal?
  Is it needed, sequenced well and aimed at the actual bottleneck? For a model,
  does the metric reward the desired capability? Are the labels observable,
  the inputs available at decision time and the output interface appropriate?
  Could several actions be valid? Move between technical details, how the team
  works and the larger strategy.
- **Look outside the current approach.** Revisit primary research, existing
  tools, pretrained systems, simpler implementations or baselines and earlier
  artifacts when they could change a decision. Distinguish a published method
  from our implementation,
  and a component test from a test of the whole pretrained system. Assess
  transfer at our data scale and interface; popularity is not evidence of fit.
- **Keep dependencies honest.** Judge preparation and downstream work by the
  outcome each enables or uncertainty it resolves. Parallel tracks may prepare
  for later data
  or deployment without delivering the final capability immediately. Qualify
  independently usable outputs separately where the evidence allows it;
  uncertainty in one output need not invalidate every other output.
- **Turn a clue into a decision.** State the observation, plausible competing
  explanations and the cheapest useful discriminator or existing evidence
  that could change the next investment. A negative result can eliminate a
  choice. Do not turn every interesting clue into a new experiment.

Prefer established methods and reusable components when they fit. Weigh total
research cost: agent time, setup, integration, compute, review and human attention.
Time-box optimization against the value of getting the result. Let worthwhile
runs finish, revisit stale bets without defending sunk costs, and remain quiet
when intervention would only create activity. Scheduled checks need no invented
breakthrough, but can pursue a consequential unresolved question while other
work proceeds.

## Experimental discipline

Use these rules for experimental claims. Other tasks need checks suited to their
outcome and risk; an advisory check-in is not a full audit of every activity.

1. **Name the uncertainty.** An experiment, review or benchmark should affect
   a decision. A repeat needs a reason, such as seed sensitivity or a changed
   condition; completion alone does not justify another validation round.
2. **Separate exploration from confirmation.** Exploration finds candidates
   and may reuse development evidence; choose seeds and controls for the
   uncertainty, not a fixed one-seed rule. Confirmation tests a stated claim
   against appropriate matched controls. Label results for their actual scope.
3. **Fix confirm decisions before outcomes.** Record the arms, seeds, splits,
   metrics, endpoint and decision rule in the project's accepted record. Review
   and freeze a confirm judge before its results are read. Choices made after
   seeing outcomes belong to exploration, not the original confirm claim.
4. **Validate measurements before scaling.** Inspect a small real sample
   containing demonstrated failures and valid controls. Synthetic tests alone
   cannot establish that a label is true. Reuse accepted unchanged evidence.
5. **Bound resource use.** Paid or long-running jobs need a forecast, an
   authorized finite envelope and a verified end to resource consumption.
   Distinguish forecasts, reservations and conservative bounds from actual
   provider charges; never add an already-covered reservation to the bill.
6. **Keep sufficient provenance.** Retain the data/split, code, configuration,
   checkpoint when applicable, report and evidence location needed to assess
   the claim. Reuse existing identities and hashes; scale record keeping to
   the result instead of generating a second delivery ritual.
7. **Preserve judged evidence and respect data use.** Do not rewrite a pinned
   packet to hide a failure; record corrections or superseding results beside
   it. Reused development data is not fresh confirmation. An infrastructure
   retry does not automatically consume unseen evaluation data or require a
   new dataset. Follow the actual split and exposure contract, and do not
   alter sealed-data access merely to resolve an uncertainty faster.
8. **Review the changed boundary.** Preserve required reviews and focus them
   on changed behavior and unresolved findings. Follow project rules for live
   action, spend enforcement, data admission and sealed-data access. An ordinary
   exploratory change does not automatically require a new independent review.

## Records and communication

The connected work tracker holds each independently acceptable result: owner,
acceptance, current evidence, limitations and next action. Workers publish a
substantive result once, with media when useful. Label demos as offline
predictions, training footage, live behavior or mock data as appropriate.
Lane notes hold findings, plans hold design, and panes hold coordination;
none is a second status queue. Preserve unrelated shared-checkout work.

Lead with what was learned and what it changes. Distinguish produced, accepted,
landed and demonstrated. Check current records before asking the person to
repeat data collection or another completed prerequisite. A run's normal quiet
period is not a stall; repeated preparation without a usable attempt warrants
finding the blocker and shortening the path. Park workers without an independent
ready deliverable. Keep advisory messages focused on consequential direction
changes, at the cadence the person chose, rather than worker-level micromanagement.
