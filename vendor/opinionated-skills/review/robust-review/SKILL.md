---
name: robust-review
description: >-
  Maintainability-centered code review. Hunts spaghetti code, bad AI-generated code,
  brittle code, and duplicate or divergent implementations that drift out of sync —
  anything that makes the codebase harder for the next agent or human to navigate,
  understand, and change safely. The goal is a codebase that's legible and robust to
  change, not just correct today. Trigger with /robust-review, optionally scoped to a
  path or area.
---

# robust-review

Review code for **maintainability** — how easy and safe it is for the *next* worker (agent
or human) to read, navigate, and change this code without breaking it. Correctness and
performance are other reviews' jobs (`/code-review`, `/perf-review`); this one optimizes for
the codebase staying legible and robust over time.

The lens for every finding: **would the next agent or human be slowed down, misled, or set
up to introduce a bug because of how this is written or organized?** If yes, it's a finding.

Four things degrade a codebase fastest, so weight the hunt toward them:

1. **Spaghetti code** — tangled control flow and mixed responsibilities: long methods that
   do unrelated jobs, state mutated from too many places, nested conditionals that hide the
   happy path, and flows that require whole-file simulation to change safely.
2. **Bad AI-generated code** — code that looks plausible but adds noise or fake confidence:
   over-engineered abstractions for one caller, defensive cruft for impossible states,
   redundant comments narrating the obvious, dead scaffolding, inconsistent half-applied
   patterns, vibes-named symbols, shallow tests, and invented seams that don't match the repo.
3. **Brittleness** — code that works now but breaks the moment someone touches nearby:
   hidden coupling, magic constants, assumptions encoded implicitly, copy-tweaked logic,
   missing seams, "change one place must change three" hazards.
4. **Duplication & drift** — the same concept implemented more than once, so the copies
   silently diverge. The highest-value find: two implementations of one idea that already
   disagree, or are one edit away from disagreeing.

## When to use this

- User runs `/robust-review` (optionally scoped: `/robust-review src/auth`, or a topic like
  `/robust-review the new payments module`).
- After a burst of AI-generated code, a fast feature push, or a merge of parallel agent work
  — exactly when slop, dupes, and brittleness accumulate.
- Before onboarding (human or agent), a refactor, or handoff, when legibility matters most.

## Scope

- **With an argument**, review only that path / area.
- **With no argument**, review the current diff (staged + unstaged vs the base branch) —
  the code most likely just written by an agent. If the tree is clean, ask whether to
  review a specific module or do a broader sweep; a whole-repo maintainability audit is
  large, so confirm scope before deep work.
- Always read enough *surrounding* code to judge fit — maintainability is relative to the
  conventions and structures already in the repo, not an abstract ideal.

## Workflow

1. **Learn the repo's grain first.** Before flagging anything, read enough to know the
   established patterns: directory layout, naming, error handling, the existing utilities
   and abstractions, the idioms this codebase already uses. Most maintainability findings
   are deviations from a local norm — you must know the norm.
2. **Map concepts to find duplication.** For the code in scope, identify what each piece
   *does* conceptually, then look for the same concept elsewhere (grep for sibling
   implementations, parallel helpers, copy-pasted blocks). Note where logic is duplicated
   and — worse — where the copies already differ.
3. **Hunt spaghetti, generated-code artifacts, and brittleness** against the checklists
   below, judging each against the repo's grain from step 1.
4. **Rank by maintenance cost.** Order findings by how much they'll slow or trip up the
   next worker × confidence. A divergent duplicate of core logic beats a clumsy variable
   name. Don't pad with nits.
5. **Report** (see Output) and **optionally fix** with `--fix`: apply the safe, mechanical
   consolidations and cleanups (dedupe, delete dead code, rename, extract a shared seam);
   leave behavior-changing or architectural refactors as recommendations unless asked.
   Maintainability fixes must not change behavior — verify that (tests / types) before and
   after, and say if you couldn't.

## Calibration

The four axes above are the checklist. What a generic maintainability pass gets
wrong here:

- **Already-divergent copies are the highest-value find** — duplicates that no
  longer match (one handles a case the other doesn't, one has the fix) are a latent
  bug and the strongest argument for dedup. When recommending dedup, name the single
  canonical home and have the others reference it — don't just note "these are
  similar."
- **Generated-code fingerprints** — prompt-shaped comments, generic "robust" helpers,
  excessive fallback paths, broad `Any`/dictionary plumbing, or local mini-frameworks
  that don't match the surrounding code's names and seams.
- **Invented integration surface** — adapters, request shapes, event names, cache
  keys, or lifecycle hooks that look reasonable but are not used elsewhere in the
  repo. Trace to the canonical implementation before accepting them.
- **Compiler-appeasement clutter** (Swift) — broad actor hops, force unwraps, `try?`,
  type erasure, or `@unchecked Sendable` added to quiet errors without preserving the
  design invariant. Flag the missing invariant, not just the syntax.
- **Shallow tests** — tests that only assert the mock path, mirror implementation
  details, or bless generated output without exercising the real boundary.
- **Knowledge duplicated across code and docs/config** — a rule encoded in code and
  also in a comment/README/schema that can drift. One canonical source; the rest
  references it.
- Recommend the smallest behavior-preserving untangling step, and extract a helper
  only where the extracted name clarifies intent.

## Output

Group findings by axis, each ranked by maintenance cost:

- **Spaghetti code** — the tangled flow or mixed responsibility, why it makes the next edit
  risky, and the smallest local untangling move that preserves behavior.
- **Bad AI-generated code** — the generated-code artifact, why it does not fit the repo's
  grain, and whether to delete, inline, rename, consolidate, or replace it with an existing
  local pattern.
- **Duplication & drift** — concept, its copies (`file:line` each), whether they've already
  diverged, and the proposed canonical home.
- **Brittleness** — what will break and under what future edit, plus the seam/type/guard
  that would make it robust.
- **Looks good** — code in scope that's already clean and legible; say so, don't pad.

Lead with the single change that most improves navigability/safety for the next worker.
Frame fixes in terms of DX: "the next agent grepping for X will find two versions and pick
the wrong one — here's the one home."

## Notes

- **Respect the repo's grain** (per the user's global rules) — converge on the patterns the
  codebase already uses; don't impose a different style under the banner of "maintainability."
  If an existing pattern is genuinely the problem, flag it as such rather than silently
  forking a new one.
- **Solve for the long term** — prefer the root consolidation over a local patch, but keep
  fixes behavior-preserving; call out larger refactors as recommendations with their payoff.
- **Don't over-correct into different slop** — deleting a useful abstraction or inlining
  shared logic to "reduce indirection" can be its own anti-pattern. The test is always:
  does this make the codebase easier and safer to work in?
- **Optimize for agents *and* humans** — clear names, one home per concept, encoded
  assumptions, and discoverable structure help an LLM navigating by grep as much as a human.
- **Complements, doesn't replace** — pair with `/code-review` (correctness bugs),
  `/simplify` (mechanical reuse/efficiency cleanups), `/perf-review` (performance), and
  `/docs-review` (docs vs code).
