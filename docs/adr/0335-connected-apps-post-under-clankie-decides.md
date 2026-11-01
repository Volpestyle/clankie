# 0335. Connected apps post under "Clankie decides" without waking him

Status: accepted (James, 2026-11-01). Amends
[ADR 0305](0305-connected-apps-write-issues-as-agents.md). Tracks
[issue #186](https://github.com/Volpestyle/clankie/issues/186).

## Context

ADR 0305 let a connected app write the owner's issues under the project's
**Posting to your tracker** setting. On **Clankie decides** it held an app's
write for Clankie unless the owner had handed the lead to the apps. Each held
write woke Clankie's lead model, which read the post, checked `clankie work
posts` and let it through: a model turn and lead context spent on a plain
issue the owner's setting already covered. Issues #175 to #179 all went that
way. James asked for posts the setting allows to go straight through the
service.

## Decision

On **Clankie decides**, a connected app's `save_issue` and `comment_issue`
post like Clankie's own writes, whoever leads. A connected app is a lead the
owner signed in himself (Claude Duet, Grok Bot), so it needs no second lead to
decide its work. The service posts it; no conversation is woken.

The other settings are unchanged: **Go ahead** posts, **Ask me** waits for the
owner's OK in his feed, **Read only** refuses. A hired worker's write on
**Clankie decides** still waits for Clankie, as do the host's own drops.

## Consequences

- An app's issue costs no lead turn and nothing in the lead's context.
- An app's writes are bounded by the posting setting alone. An owner who wants
  to see each one first picks **Ask me**.
- The service no longer reads who leads to admit an app's write.
