---
name: update-review-ethos
description: Distill durable team preferences from a genuinely good MR review into the "Team code ethos" section of the team's shared agent-instructions file (CLAUDE.md). Invoke as /update-review-ethos [MR ref or pasted feedback] after a review worth learning from — not after routine reviews.
---

# update-review-ethos

Turn a high-quality MR review into durable agent instructions. The target is
the **"Team code ethos (review expectations)"** section of the team's shared
`CLAUDE.md` — the instructions file that sits above the team's repos, mirrored
to other agents via an `AGENTS.md` symlink (edit only the CLAUDE.md, never the
symlink). Resolve that path first; if no shared file exists, ask where the
team keeps standing review doctrine instead of inventing a location.

## When this applies — the bar

Only distill reviews that reveal *standing preferences*, not one-off feedback.
Signals of a distill-worthy review:

- The reviewer asks for a **pattern**, not a fix ("rely on backend response
  types", "use RHF here", "use the cn helper") — especially repeated across
  files or MRs.
- The ask generalizes beyond the diff: you can state it without naming the
  file.
- It reflects architecture/consistency doctrine, not taste about one artifact.

Do NOT distill: bug findings, one-off naming/copy nits, anything specific to a
single feature's design, or preferences already covered by an existing rule.
If the user invokes this on a review with nothing durable in it, say so
instead of manufacturing rules.

## Workflow

1. **Gather the review** — from the argument (MR `!ref` via
   `glab api projects/<url-encoded project path, e.g. group%2Fsubgroup%2Frepo>/merge_requests/<iid>/discussions`,
   or pasted text). Read every reviewer comment, including resolved ones.
2. **Extract candidates** — for each comment, ask: "would a fresh agent
   working any of the team's repos waste a review cycle rediscovering this?"
   Keep only yeses.
3. **Generalize** — rewrite each keeper as a rule statement: imperative,
   repo-agnostic wording, with the *why* only if non-obvious. One line each,
   matching the existing section's voice.
4. **Dedupe against the existing section** — if a candidate refines an
   existing rule, tighten that rule in place rather than appending a sibling.
   The section should stay short enough to read in 30 seconds; if it grows
   past ~8 bullets, merge or prune before adding.
5. **Edit** the shared CLAUDE.md under `## Team code ethos (review
   expectations)` (create the section after the repo bullets if it's missing).
6. **Report** the diff of the section to the user, and note which review
   comments produced which rules (traceability, in chat only — do not cite
   reviewers by name in the file).

## Gotchas

- The shared instructions root may not be a git repo — check before assuming
  MR ceremony. Ungoverned edits are live immediately for every agent working
  under it.
- Repo-level `CLAUDE.md`s usually ARE git-tracked; if a rule is truly
  repo-specific doctrine, note that it could graduate there via a tiny MR —
  but don't commit that change as a side effect of this skill.
- Codex/other agents inherit via the `AGENTS.md → CLAUDE.md` symlink; never
  edit the symlink side.
