# Design docs

Writing guidance for [work-items](../SKILL.md) when an issue outgrows its body.

Bigger than an issue body: a living doc attached to the project, revised in
place as decisions land.

- **TL;DR first** — one paragraph enumerating the concrete deliverables
  ("three new Postgres tables, three small keyword endpoints, one runtime hook,
  new UI for adding keywords at flow creation"), ending with what it unlocks
  later.
- **Sections by system layer** (DB / API / Runtime / UI), each header carrying
  its ticket(s): `## Runtime ([ABC-1399](url) · [ABC-1400](url))`.
- **Bullets, not prose — each bullet is `decision — why`**, with the rejected
  alternative in parens. Nest per column or field under a table's bullet, and
  use bold-labeled sub-lists (**Rollout:**, **Ceiling:**) for justifications
  that forecast a future scenario.
- **State the negative-space decisions**, with reasons — "No per-keyword
  PUT/PATCH — keywords have no mutable attributes", "No `account_id` — the
  authorizer middleware owns account scoping". What you decided _not_ to build
  is the part nobody can re-derive from the schema.
- **Name the flags it depends on.** Which existing flags gate what this now
  needs — the one that gets missed, because it's about code you aren't writing
  and no diff-scoped review sees it ("linking to a specific message is retired"
  is what made links require the newer `flows-enabled` flag).
- **Numbered lists for migrations and cutover sequences**; pseudocode with
  inline comments for runtime flows; sequence diagrams as images, in Before /
  After pairs where the After caption states only the delta ("**After** — step 2
  disappears; the step-1 hit already carries the config").
- **Sequence of Work** — a `→` chain of linked tickets, each with a 2-4 word
  label, plus out-of-band ordering notes on their own lines ("ABC-1400 can land
  any time after ABC-1398").
- **End with Open questions**, each with an owner and a leaning, not a bare
  question. A question nobody is holding doesn't get answered.
- **Revise in place when a question resolves** — rewrite the body to the new
  decision rather than appending, and turn the open-question entry into a
  verdict plus what is still deferred. Re-read the doc immediately before each
  edit; these get hand-edited between passes.
