---
name: codebase-cleanup
description: >-
  Lead an evidence-ranked cleanup of a codebase: map it, audit it through
  parallel lenses, verify the findings, then land reviewed deletions and
  simplifications in small gated batches. Use when asked to clean up, audit,
  prune or simplify a repo, its dead code or its tests. Not for ordinary
  feature work. Builds on `lead`.
---

# Codebase cleanup

You lead the cleanup: you map the system yourself, fan focused lenses out to
agents, verify what they bring back, rank by ongoing cost, then turn the work
into small batches that leave behavior unchanged and land fast. The audit exists to drive changes. A report nobody acts on
is not the deliverable.

Load `lead` for dispatch, `work-items` for the tracker, `fleet-resources` for
checks and `shared-checkout` before commits.

## Stance

Put these, verbatim, in every brief:

1. **Chesterton's fence.** Assume code exists for a reason. Learn it (blame,
   commit messages, ADRs, issues, call sites) before calling it wrong. The job
   is to find the reasons that are no longer true.
2. **Follow the cost, not the aesthetics.** A finding matters if it slows
   changes, causes bugs or blocks people. Ugly code nobody touches is low priority.
3. **Churn × complexity.** Complex files that change often are where the cost lives.
4. **Essential vs. accidental complexity.** Auth, permissions, billing,
   concurrency and protocol boundaries may be complex. Flag only what the
   implementation added.
5. **Evidence or it didn't happen.** Every finding cites `path:line` and, where
   possible, a count or measurement.
6. **Deletion is a first-class fix.** Look for code that can simply go.
7. **Incremental over rewrite.** Small, shippable steps. Propose a rewrite only
   with overwhelming evidence, and say what would make it unnecessary.

## Phase 1: map (yours)

Before any fan-out, establish:

- the repo's shape (packages, runtimes, build, tests, lint, CI);
- its strictness settings;
- its entry points, domains and intended boundaries;
- its size by package;
- its history: age, commit volume, recent authors.

Read the repo's own rules first: `AGENTS.md`, ADRs, its landing gate.

Rank hotspots: the ~20 files with the highest churn × size, plus each file's
bug-fix churn and its count of distinct recent authors. The commands are in
[reference/lenses.md](reference/lenses.md).

Write the map and hotspots to `.local/cleanup/<date>/` in the repo. That folder
is ignored scratch, never committed. Then choose the lenses and partition them
so no agent gets a scope too big to read.

Don't stop for approval here. Post the map summary and the lens plan to the
tracker issue that owns the cleanup (create one if none exists), then continue.

## Phase 2: fan out

Run the lenses in parallel. Read-only lenses suit native subagents of your seat
or of one hired seat: they don't count against the hire cap, and their heavy
steps still queue. Give each agent its own scratch subdirectory. Every brief carries:

- the Stance;
- the relevant map and hotspot excerpts;
- its lens, exact scope and output file;
- the finding format;
- "Return at most 10 lines; everything else goes in your file."

The lens catalog and finding format are in
[reference/lenses.md](reference/lenses.md). Skip lenses that don't fit, and add
one when the map shows something specific, such as codegen, a legacy island or
a hand-rolled state layer.

## Phase 3: verify

Agents overgeneralize and miss why code exists. Skim every findings file and
follow up on anything vague. For each finding you'll rank high, start a
**fresh** agent that hasn't seen the original reasoning. Give it only the claim
and the locations. It confirms or refutes from the code and the history, and it
actively looks for a legitimate reason the code is this way. Drop or downgrade
what fails, and keep a short list of cuts with the reasons.

## Phase 4: plan

Publish the report as the owning issue's result (see `linear-issues`):

- **Summary:** overall health, the biggest problem, the biggest opportunity.
- **Top issues:** 3 to 6, ranked by ongoing cost, linked to finding IDs.
- **Deletion candidates:** what can go, estimated LOC, safety confidence, prerequisites.
- **Roadmap:** an ordered list of batches. Safety-net work comes before risky
  refactors: tests around hotspots, runtime validation at boundaries,
  incremental strictness.
- **Looks bad, leave it alone:** stable, rarely touched or essential complexity.
- **Open questions:** where intent couldn't be determined and the answer would
  change a recommendation.
- **Method and limits:** which tools ran, what wasn't covered, what verification cut.

Push the findings folder with `clankie evidence push` and cite the printed links;
don't commit it. Create child items only for batches you'll actually run.

## Phase 5: land batches

Each batch is one reviewed, independently landable change:

1. **Before:** run the repo's landing gate (through `clankie heavy`) and record
   the result as the baseline.
2. **Change:** make one coherent cut. Read every file you delete or reduce in
   full. Keep tests that guard trust boundaries, contracts, protocol shapes,
   security and data integrity. Cut tests that only pin incidental output, mocks
   or snapshots.
3. **After:** run the narrow checks for what you touched, then the same gate.
   Behavior stays unchanged unless the batch says otherwise and the owner
   decided it.
4. **Land:** follow the repo's landing rule; where it lands on `main`, push
   straight there. Open a pull request only when the repo or the owner asks for
   one. The diff is only the cut: evidence goes to `clankie evidence push`, and
   the running tally of lines and cases removed lives on the owning item, never
   in repo docs or ledgers.

Decide reversible cuts yourself. Bring the owner only cuts that change what the
product does: removing a feature, setting or public API, or changing a protocol
or data format. Each comes as a concrete recommendation, and other batches keep
going meanwhile.

Stop and re-plan when a batch's gate fails for a reason the cut didn't
explain, when verification undermines a ranked finding, or when the next
batches stop paying for their review.

## Handoffs

Long cleanups outlive a seat. Before a seat's context fills, it writes a
handoff to `.local/HANDOFF-<item>.md` with:

- prepared commits and the gates they're queued on;
- the running tally;
- which inventory has been reviewed and which hasn't;
- the next cut.

A fresh seat starts from that file and the owning item's latest result. It
never starts from memory.
