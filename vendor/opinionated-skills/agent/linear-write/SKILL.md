---
name: linear-write
description: >-
  Voice overlay for writing Linear content — issue descriptions, acceptance
  criteria, comments, worklog notes, and design docs — in the user's own voice.
  Load alongside linear-issues, which owns all the structural and length rules.
  Not for triage filing (a repo-owned triage skill covers that where one exists).
---

# linear-write

**Load `linear-issues` first.** It owns authorization, API mechanics, registers,
the result-update format, notation and document structure. This overlay changes
voice, not the threshold for publishing another update.

This skill is the remainder — the small set of habits that make a post sound
like *them* rather than merely being well-shaped. Nothing here is a structural
rule.

- **Discussion replies are genuinely casual.** Lowercase starts, "yea", "u",
  "imo", "lol" are all in register. A question closing a reply keeps the space
  before the mark: `@teammate What do u think ?`
- **Don't normalize the quote mixing.** Single quotes for literal values
  ('body', 'STOP') sit next to backticks for identifiers
  (`processStateChange`). Both appear in the same sentence on purpose.
- **Leave the contractions and missing apostrophes alone** — "Dont",
  "shouldnt", "wont". Copyediting them is what makes a post read as though
  someone else wrote it.
