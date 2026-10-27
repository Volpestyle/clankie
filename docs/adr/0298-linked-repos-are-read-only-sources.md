# ADR 0298: Linked repos are read-only sources, never owners

Status: Accepted by the lead for LOCAL-VUH-41, 2026-10-27. Extends
[ADR 0270](0270-auto-rounds-measure-outcomes-and-name-drift.md) and the guided-review
source rule ([guided reviews](../guided-reviews.md)).

## Context

A project owns a repo by listing it as a workspace. That one link decides settings
context (`resolveFleetSettingsContext`), the review gate's checkout project, hire
placement and workspace membership. When two projects own one checkout, settings
resolution throws "ambiguous". Every landing from that checkout would then hold,
not only the second project's.

Clankie Work is a built-in-tracker project whose only workspace is a notes folder.
Its code lives in the clankie repos, which the `clankie` project owns. Guided
reviews read only the issue project's own repositories. Churn reads only the
project's own workspaces. So no Clankie Work review could be saved, and its churn
always read "repository unreadable".

## Decision

A project may list **linked repos**: other projects' workspaces that it reads but
does not own.

- **Who reads them.** Guided-review source authority, and Auto churn and velocity
  measurement. Membership, settings context, the review gate, hire placement and
  status lines ignore them.
- **One owner.** A linked repo must be a workspace of exactly one other project,
  never one of the linking project's own. The service checks this when a link is
  saved, and both readers check it again on every read. Removing a workspace that
  another project links is refused until it is unlinked.
- **Churn counts only the project's own work.** From a linked repo, churn counts only
  commits whose message names one of the project's issue keys: the issues the
  round's tracker read sees (closed in the window, started now, or changed since it
  began). When the tracker read is unknown, a linked repo's churn is unknown too,
  never all of the owner's churn. Built-in keys such as `LOCAL-VUH-41` are read
  whole, so they never match Linear's `VUH-41`.
- **CLI first.** `clankie project settings PROJECT --link-repo PATH` and
  `--unlink-repo PATH` edit the list through the revision-fenced owner API
  (`linkedRepos`). It is an Advanced setting with no TUI or app control.

## Consequences

Projects now have two kinds of link to a repo, an owning workspace and a read-only
linked repo, and code must keep them apart. A new consumer that decides ownership
must read `workspaces` only. A consumer that only reads code may also read
`readableLinkedRepos`.

A commit landing in a linked repo is invisible to the linking project's churn
unless its message names one of that project's issues the tracker read can see.
