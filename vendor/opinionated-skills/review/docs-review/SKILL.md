---
name: docs-review
description: >-
  Review and update documentation against the current code. Decide per doc whether to
  prune (stale/redundant/dead), simplify (bloated/confusing), or extend/enhance (missing,
  thin, or undiagrammed). Trigger with /docs-review, optionally scoped to a path or topic.
---

# docs-review

Audit docs against reality and act on the gap. The goal is docs that match the code,
read tightly, and cover what matters — not a wall of edits for their own sake.

**Always minimize duplication.** Every fact belongs in exactly one canonical home; other
docs link to it rather than restate it. This holds across every action below — when
pruning, fold duplicates into the canonical doc and leave a pointer; when simplifying or
extending, never copy content that already lives elsewhere, reference it. Duplicated docs
drift out of sync, so treat any repetition you find as debt to collapse.

## When to use this

- User runs `/docs-review` (optionally with a path, e.g. `/docs-review docs/architecture`
  or a topic like `/docs-review the chat-vault flow`).
- After a feature/refactor that likely left docs stale.
- Before a release, handoff, or onboarding when docs need to be trustworthy.

## Scope

- With an argument, review only that path/topic.
- With no argument, review the docs the repo treats as docs: `README*`, `docs/**`,
  the repo's own committed `CLAUDE.md`/`AGENTS.md`, ADRs, `.env.template`, and module
  READMEs / doc-comment headers. Only the repo-scoped `CLAUDE.md`/`AGENTS.md` are in
  scope — never the user's global/home-level agent instructions (e.g. `~/.claude/CLAUDE.md`,
  `~/AGENTS.md`). Confirm scope with the user if it's large (say, >15 docs) before deep work.

## Workflow

1. **Inventory.** Find the in-scope docs. Note last-touched vs. the code they describe
   (`git log -1 --format=%cr -- <doc>` vs the dirs it covers) to spot likely drift.
2. **Verify against code, don't trust the prose.** For each doc, open the code/config it
   claims to describe. Check that file paths, commands, env vars, flags, function/var
   names, and flows still exist and behave as written. Run a command only if it's safe and
   read-only. This is where stale docs are caught — assume nothing from the doc alone.
3. **Classify each doc** into one action (see Decision rubric). For non-trivial scope,
   present the classified list to the user before editing — let them veto prunes especially.
4. **Act:**
   - **Prune** — delete dead docs or cut redundant/duplicated sections. Fold anything still
     useful into the canonical doc first; leave a pointer if something linked to it.
   - **Simplify** — tighten bloated or rambling sections; cut hedging and repetition;
     prefer a table or short list over prose where it's denser. Don't lose real content.
   - **Extend/enhance** — fill gaps, correct what drifted, add an example, add or update a
     **Mermaid diagram** for any flow/system that's hard to follow from prose alone (per
     repo convention — diagram complex systems, keep diagrams next to what they describe).
5. **Keep code and docs consistent.** If a doc is right and the code is wrong (or vice
   versa), flag it — don't silently "fix" the doc to match a bug.
6. **Verify links & build.** Check internal links/anchors still resolve after edits. If the
   repo builds docs (a docs site, mermaid lint, markdownlint), run it.
7. **Report.** Summarize per doc: action taken, why, and anything you flagged for the user
   to decide (risky prunes, code/doc contradictions, gaps too big to fill blindly).

## Decision rubric

- **Prune** when content is dead (describes removed code), duplicated elsewhere, or never
  read. Redundancy is debt — one canonical home per fact.
- **Simplify** when it's accurate but bloated, repetitive, or burying the point.
- **Extend/enhance** when it's missing, thin, drifted, or would be far clearer with an
  example or diagram.
- **Leave alone** when accurate, clear, and complete. Not every doc needs a change — say so.

## Notes

- Respect repo conventions: match the surrounding doc style, structure, and tone; write
  edits in the doc's existing voice (mirror the repo's CLAUDE.md/AGENTS.md rules).
- Default diagrams to in-repo Mermaid; reach for Excalidraw/Figma only when richer visuals
  genuinely help.
- Prefer the larger correct fix over a quick patch, but don't invent content to fill a gap
  you can't verify — flag it instead.
- Keep edits reviewable: scoped commits/sections, no drive-by rewrites of unrelated docs.
