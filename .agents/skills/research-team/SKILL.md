---
name: research-team
description: >-
  Use when leading agents on a question whose answer can be wrong in ways that
  look right: training or evaluating a model, measuring performance, labelling
  data, benchmarking, or any result that needs evidence rather than a passing
  build. Runs the fleet as a research lab: a lead who holds the question,
  lane owners, independent reviewers, fixed judges and receipts. Builds on
  `lead`, which it does not replace.
---

# Research team

Some work can't be finished by just shipping it. A model can score well on the
wrong data, and a benchmark can measure the harness instead of the system.
A label can look plausible and still be false. This skill runs the fleet like
a lab, so that what it reports is true and not just finished.

Load `lead` (plus `swarm-lead` or `herdr-lead`) for dispatch mechanics,
`work-items` for the record, and `shared-checkout` before any worker commits.

## Roles

- **Lead: the principal investigator.** Holds the question, the budget,
  dispatch and acceptance. Translates every worker update into plain language
  for the person. It is the single voice they talk to. It doesn't run
  experiments itself.
- **Lane owners.** Name each worker after the question it owns
  (`idm-owner`, `explore-policy`, `live-loop`), not after a task. A lane owner is
  long-lived, carries its result from prerequisites to its next usable
  experiment, and is the only writer of its lane notes.
- **Reviewers.** They never build. Each returns **LAND** or **REJECT** with
  findings. Pick one outside the lane, preferably from another model family
  (Codex reviews Claude's work and vice versa). The lead verifies each finding
  before dispatching a fix to the owning lane. A lane's own tests and report are
  evidence, not a review.
- **The person.** Supplies data and taste, and makes the funding calls. Bring
  them decisions and results, not coordination.

## Protocol

1. **Name the question and the uncertainty.** Every experiment, review or
   benchmark names what it will settle. "Run it again to be sure" is not a
   question.
2. **Exploratory or confirm, never both.** Exploratory runs (one seed, cheap,
   labelled EXPLORATORY) find candidates. A confirm run tests one candidate
   against a matched control.
3. **Pre-register confirm runs before launch.** Write down and commit:
   - the arms;
   - the seeds;
   - the data split;
   - the metric;
   - the thresholds;
   - the pass rule, e.g. "must beat the control in every seed".

   The judge's code is reviewed and frozen before anyone reads a result. Never
   choose a threshold, epoch or decoder after seeing the outcome.

4. **Validate a measurement before scaling it.** Inspect a small real sample,
   with real failures and valid controls, before a large extraction or run.
   Synthetic tests alone can't show that a label is true.
5. **Put a budget on every run:**
   - a hard dollar or time cap, with a forecast;
   - a funded stop time;
   - a teardown proof: zero containers or jobs left when it ends.

   Cost is reported as a conservative allocation, not as the invoice.

6. **Leave a receipt for every result:**
   - hashes of the inputs, data, checkpoint and report;
   - the exact commit;
   - where the evidence lives.

   A result without an inspectable receipt isn't done.

7. **Freeze what was judged.** A reviewed packet or evidence file is never
   edited or moved, not even to fix a link. A failed experiment stays frozen
   as a failure. A new attempt needs a new pre-registration and fresh
   validation data, since the spent data can't be reused.
8. **Review the changed boundary.** Reuse accepted evidence for unchanged
   inputs, and re-review only the delta and any open findings. Anything that
   acts on the world (sends input, spends money, decides what enters a
   training or evaluation set) is reviewed before it is relied on.

## Records

- The work tracker (`work-items`) holds each result:
  - acceptance;
  - the owner;
  - current evidence;
  - limitations;
  - the next action.

  Workers publish a substantive result there once, as the connected tracker
  identity, with media when it helps (a replay, a chart, a demo clip). Every
  demo is labelled for what it is: offline predictions, a training session,
  or mock data.

- Lane notes hold measured facts. Plans hold design. Panes and Swarm hold
  coordination. None of them is a second status queue.
- Shared checkout: a worker announces a short commit window and stages exact
  paths. It never stashes, resets or amends another lane's work.

## Running the team

- **Keep capacity tied to a deliverable.** Park a worker that has no
  independently ready result, and don't fill idle panes with new scope.
- **Report honestly.** Say what was produced, accepted, landed or
  demonstrated, with its evidence and the next blocker. A running pane isn't
  progress. When two updates in a row add only preparation, name the blocker
  and shorten the path to a real attempt.
- **Show each result with its caveat attached:** "illustration, not an
  evaluation", "single seed", "offline, not live".
