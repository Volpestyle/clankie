---
name: linear-agent-session
description: Write an [Agent Session] handoff document in Linear at the end of a substantial agent work session, recording what a later agent or human can't re-derive from the code. Use after a release or migration, when handing a stack of branches to review, or when asked for a handoff, session doc, or "write this up in Linear".
---

# Agent session documents

A Linear document attached to the project, titled
`[Agent Session] <what it covered> → <where it got to>`, e.g.
`[Agent Session] Search reindex → prod release`.

Its job is to record **what cannot be re-derived**: anything a later agent can
get from the diff, the ticket, or a log query does not go in. One-moment
numbers, plans that turned out wrong, findings deliberately *not* acted on —
those disappear the second the session ends.

Write one when unresolved cross-issue state or durable decisions have no existing
home: an unfinished cutover or integration sequence the next owner cannot recover
from current issues and repo docs. Update those existing homes when they suffice;
a substantial session alone does not warrant another document. Routine human
progress uses `linear-issues`' result-update format.

## Structure

Open with the date and one sentence of scope. Include only sections with useful
non-duplicated information; link existing records instead of filling every section:

**What shipped** — a two-column table, MR ↔ ticket, one row per change. Include
the release tags. This is the only section that is pure lookup, and it earns its
place by making every following section referenceable.

**Where the plan was wrong** — the highest-value section, and the one people
skip. What the plan said, what actually happened, and *the mechanism that made
the difference matter*. Then the transferable lesson, stated once —
illustrative, from one past session; match the shape, not the subject:

> `aurora-migrate-prd` applied five migrations, not three… so TFN campaign
> creation was broken for the whole window between the migration and the API
> deploy — a window the plan created deliberately without knowing it had a cost.
> Lesson: the drizzle journal delta is the truth about what a migration job will
> apply, not the ticket list the plan was written from.

If the plan was right end to end, say so in one line. Don't manufacture a lesson.

**Numbers** — dry run, execute, and verify side by side in a code block, so the
reader can see the prediction match (or not) — illustrative:

```
agent_configs   dry run:  1254 agents · flows to link 325
                execute:  migrated 1254 · failed 0 · flows linked 319 · orphaned 6
```

Then say which number is load-bearing and why — `aurora only: 0` is useful
later only with the sentence explaining it proves no row was written during
the cutover window.

**What verification actually proved** — per path, with the evidence, and honest
about how it was obtained. Distinguish paths proven by real traffic from paths
that needed a manual `curl` because production volume was never going to reach
them. A path nobody exercised is unproven; say that rather than implying
coverage.

**False alarms worth recording** — the investigation that looked like a
regression and wasn't, with the reasoning that settled it. Without these the
next person re-runs the same dead end.

**Follow-ups branched** — for work that exists as commits but not as MRs. State
plainly that nothing is open yet. Then per branch: commit SHA, file/line counts,
what it does, and the things that would bite a reviewer. Where branches are
stacked, give the **merge order and the reason** — a conflict that resolves once
in the stack rather than at merge time is exactly the kind of fact that is
expensive to rediscover. Include the pre-filled MR-creation URLs with the
correct `target_branch`, since defaulting to `main` silently shows the parent's
diff too.

Record review status honestly per branch: reviewed, reviewed by what, or not
reviewed. "Verified" (`tsc` clean, tests pass, ACs present) is not "reviewed" —
keep them separate.

**Findings deliberately left** — anything found and *not* fixed, with the reason
and what it's blocked on. This is the section that prevents a later agent from
"fixing" something on purpose left alone, or re-finding it and re-arguing it. If
a finding needs a decision from a human, say which decision.

**Open** — numbered, one line each: known problems, unticketed. Gaps in
monitoring, latent rot, things noticed in passing that belong to nobody yet.

## Rules

- **Exact identifiers everywhere** — commit SHAs, `file:line`, log strings,
  timestamps, real numbers. A vague session doc is worse than none, because it
  reads as coverage.
- **Every figure and status traces to a tool result from this session.**
  Before writing a number, a "pushed", a "verified", check you can point at the
  output that proves it; what you can't, mark unverified rather than rounding
  up to done.
- **Attach it to the project**, not to an issue — it spans issues by nature.
- **Update the existing doc rather than posting a second one** when the same
  session continues — and **re-read it immediately before each update**. These
  docs get hand-edited between passes; a stale copy in context will clobber
  someone's trim or rewording. `save_document` semantics and the media
  round-trip hazard are in `linear-issues`.
- **Covering work done in other panes?** Read those sessions' transcript JSONL
  from disk rather than prompting the agents to summarize themselves —
  passive, complete, and it doesn't inject a turn into someone else's session.
  Transcripts live under your Claude config dir — `~/.claude/projects/<cwd with
  / and . → ->/` by default, elsewhere if `CLAUDE_CONFIG_DIR` is set.
- **Say what is still true at the moment of writing.** "All three are pushed. No
  MRs exist yet" ages into a lie — date the doc and let the reader see how old
  the claim is.
- Draft in chat and get approval before creating it. Never post unprompted.

## What this is not

Not a status update — those go on the project timeline, are pinned to lifecycle
events, and are written for people tracking progress. A session doc is written
for the *next agent*, and
it is allowed to be long, technical, and uninterested in narrative.

Not a changelog. If a section could be reconstructed by reading the diff, cut
it.
