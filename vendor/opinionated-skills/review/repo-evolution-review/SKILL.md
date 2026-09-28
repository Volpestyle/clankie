---
name: repo-evolution-review
description: >-
  Analyze a repo (and optionally a sibling repo's commit history) and report two
  things separately: a narrative read of its theme, recurring patterns, and
  trajectory drawn from code plus commit history, and an objective good-and-bad
  patterns code-quality review judged against the repo's own AGENTS.md/CLAUDE.md
  conventions. Use when asked what a codebase's theme or patterns are, how it is
  evolving, or for a health / code-quality report — especially across a backend
  and its sibling client repo. Read-only. Not for a diff-scoped review
  (/robust-review, /code-review) or a docs pass (/docs-review).
---

# repo-evolution-review

Produce a two-part report on a repo: (1) a narrative read of its **theme,
recurring patterns, and trajectory** drawn from code + commit history, and
(2) an **objective code-quality review** of good and bad patterns, judged
against the repo's own conventions rather than generic taste.

## When to use this

- "Take a look at this repo / these repos — what's the theme, what patterns do
  you notice, how is it evolving?"
- Any request for a code-quality / health / good-and-bad-patterns report on a
  codebase, especially one that also wants the historical/evolution angle.
- Reviews that should span more than one repo (e.g. a backend and its sibling
  iOS/client repo) and read their commit histories together.

## Core principles

- **Judge against the repo's own rubric, not your defaults.** Read every
  governing doc first — root `AGENTS.md` / `CLAUDE.md`, nested ones in
  subdirectories, `SPEC.md`, `README.md`, `CONTRIBUTING`. These define what
  "good" means *here*. A pattern that would be a smell elsewhere may be an
  explicit, documented choice in this repo (and vice versa). Cite the specific
  rule a finding upholds or violates.
- **Be genuinely objective — symmetry is not required.** Do not manufacture a
  "bad patterns" section to look balanced, and do not pad "good patterns" with
  filler. If one side is empty, say so plainly and move on. The user explicitly
  does not want forced findings in either direction.
- **Evolution is a claim that needs evidence.** "The repo is moving toward X"
  must be backed by commit-history signal (commit clustering by area, message
  themes, files churning, things being deleted/consolidated), not vibes from a
  single snapshot.
- **Separate the two reports.** Theme/patterns/evolution is descriptive
  (what is this and where is it going). Code-quality is evaluative (is it good).
  Keep them in distinct sections so the reader can take the narrative without
  the judgment, or vice versa.

## Workflow

1. **Establish the rubric.** Read the governing docs in every target repo
   first. Note repo-specific rules that will become review criteria (e.g. "no
   backwards-compat shims by default", "strict erasable TypeScript", "one
   spawn seam"). These are the lens for the quality section.

2. **Survey structure.** Map the top-level layout, package boundaries, and the
   stated architecture (often in `SPEC.md`/`README`). Note where the docs claim
   the architecture is vs. what the tree actually shows — drift is a finding.

3. **Mine the commit history** (this is what makes it "evolution", not just a
   snapshot). Useful angles:
   - `git log --oneline -n 100` and skim message themes.
   - `git log --since=...` windows to see recent direction vs. older.
   - `git log --stat` / `--shortstat`, and `git log --diff-filter=D` for what's
     being deleted/consolidated (often the clearest signal of direction).
   - Churn by area: which dirs/files appear most in recent commits.
   - For a sibling repo, run the same passes in *its* checkout (e.g.
     `git -C ../<sibling> log ...`) and look for coupled changes across both.

4. **Fan out for breadth when the repos are large.** Spawn parallel read-only
   agents (Explore/general-purpose), one per subsystem or per repo, each
   returning findings against the rubric. Synthesize; don't dump their raw
   output.

5. **Write the two-part report:**
   - **Part 1 — Theme, patterns, evolution.** What the repo *is*, the recurring
     idioms/abstractions it leans on, and its trajectory (with commit
     evidence). Cross-repo coupling if a sibling was in scope.
   - **Part 2 — Code-quality review.** Good patterns worth keeping, then any
     genuine bad patterns / risks, each tied to a concrete file:line and to the
     repo's own guideline where relevant. Omit either subsection if there's
     nothing real to say.

6. **Keep it scannable.** Lead with a short synthesis, then the sections.
   Cite `file_path:line` so claims are checkable. Don't restate the whole
   codebase back to the user.

## Notes

- Read-only by default. This skill reviews and reports; it does not change code
  unless the user separately asks.
- If the repo has no governing docs at all, say so and fall back to the user's
  global AGENTS.md conventions, noting that the rubric is external.
