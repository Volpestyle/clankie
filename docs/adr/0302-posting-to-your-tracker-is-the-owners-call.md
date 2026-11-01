# ADR 0302: Posting to your tracker is the owner's call

Status: Accepted, 2026-10-30, on James's direction quoted below. Builds on
[ADR 0226](0226-one-tracker-tool-surface.md) and the gate ladder of
[ADR 0230](0230-fleet-responsibility-is-owner-settings.md).

## Context

Clankie and his workers write to whatever tracker a project uses: private issue
files on the Mac, the built-in tracker, Linear, or GitHub issues. The first two
never leave the owner's Mac. Linear and GitHub are shared places other people
read, and until now any write a role could make went straight there.

James put the need this way: "some projects may do their tracking in linear, or
github issues, or anything else, and some users might want clankie / workers to
never post there without their explicit permission, but some users might give
clankie / workers full reign. we want to allow for all of this".

## Decision

Each project has one setting, **Posting to your tracker**
(`trackerPosting`), with four values:

| Value       | In the app      | A write by Clankie or a worker                                        |
| ----------- | --------------- | --------------------------------------------------------------------- |
| `read_only` | Read only       | is refused, with a pointer to the issue file or the agent's own notes |
| `ask`       | Ask me          | waits as a check in the owner's feed showing exactly what and where   |
| `lead`      | Clankie decides | posts when it is Clankie's own; a worker's waits for Clankie          |
| `allow`     | Go ahead        | posts                                                                 |

- **Default `ask`** (amended 2026-11-01: the default is now `allow`; see the
  end of this record). A project with no saved value, a write no project can be
  matched to, and every Linear or GitHub project today start on Ask me. When a
  write could belong to several projects, the strictest of their values applies.
  When unsure, nothing posts without someone saying so.
- **Only outward trackers.** The setting governs Linear and GitHub issues.
  Private and committed issue files, the built-in tracker, and the local store
  Linear tools fall back to while Linear is disconnected stay on the Mac and are
  always writable. Reads are never held.
- **The owner's writes are his.** The owner's app, `clankie work owner` and
  `/v1/tracker/owner/call` are never held. The operator bearer on
  `/v1/tracker/call`, `clankie work` and a work item write over operator
  dispatch counts as Clankie, as it already does for attribution. A held work
  item write goes later as the same `work update`.
- **One check point.** Every outward write passes the same admission in
  `apps/clankie/src/tracker-posting.ts`: Linear tool calls through the MCP host
  (the lead's, a delegated worker's, internal callers'), repo-routed tracker
  calls, `/v1/work` create, update and attach, the seat issue status Clankie
  keeps, and drops. A write that was let through carries a host-only mark, so
  the layers below never check it twice.
- **Held writes are durable and post once.** A held write is a record in the
  service's state with exactly what would be posted. Ask me raises an owner
  question with a ten-second check line ("Post a comment on VUH-12 to Linear")
  answered **Post it** or **Send it back**; Clankie decides wakes the lead chat
  with `clankie work posts approve|send-back ID`. Approval re-reads the setting
  first: read only refuses it, and a Clankie-decides write whose project moved
  to Ask me goes to the owner instead. A post is marked as sending before it is
  sent; one interrupted there is `uncertain` and never sent again. The same
  waiting write asked again is the same record. The asker hears the outcome
  through the lead chat.
- **Drops reach Linear and GitHub projects.** A drop there is kept first as a
  private issue file (creating `.clankie/work`), then posted as a new issue under
  the setting. The feed shows where it went. Projects on Auto still keep the
  built-in tracker and refuse drops.
- **CLI first.** `clankie project settings P --posting
read-only|ask|lead|allow|default` (or `posting VALUE`) sets it; readers opt
  into `trackerPosting` with `includeTrackerPosting=true`, advertised by
  `projectTrackerPosting: true`. `clankie work posts` and `POST /v1/work/posts`
  list and decide held writes. The app's Project settings control and its feed
  checks follow on the same API (Common tier).

Linear sync stays on. The owner's own Clankie project keeps its work in private
issue files with Linear on Read only, so history still reads from Linear and
nothing goes back.

## Consequences

- A worker that posts to Linear on an Ask me project now gets `posting_held`
  and carries on; the owner sees one check per write, not per retry.
- Owner checks are bounded to 2,000 characters of detail; a longer write is
  refused rather than shown cut.
- GitHub issue writes through the GitHub MCP server, outside Clankie's tracker
  tools, are not covered here.
- The setting holds no credential and grants nothing: Go ahead only stops
  asking, within whatever the role and the connected account already allow.

## Amendment: Go ahead is the default (2026-11-01)

Answering a feed check for every post turned out to be busywork. James: "i dont
wnana have to give permissions everytiem some agent wants to post to linear...e
tc, thats a big waste, so lets not do that, just grant permissions if possbile".

A project with no saved value, and a write no project can be matched to, now
start on `allow` (Go ahead). The four values, the strictest-wins rule, the
always-writable files on the Mac and the owner's own writes are unchanged.
Anyone who wants each post shown first picks Ask me for that project, and a
saved value of any kind keeps applying.

## Amendment: Held writes follow their project (2026-11-01)

A held write named the tracker its project used when it was asked. When the
clankie project moved from Linear to GitHub issues, its waiting writes still
showed as approvable checks, and each approval was refused (#159).

A held write now follows its project. Clankie compares each waiting write's
destination with its project's saved tracker at start, every minute, and again
on approval. A new issue moves to the new tracker with what that tracker takes
(title, description and priority, plus labels and a plain state on GitHub),
names anything left out, and waits for the owner's OK there whatever the
setting, because his OK named another place. A change or comment on an issue in
the old tracker, or a project now kept on the Mac, ends `refused` with why. The
old feed check is taken back, and the asker hears what happened. The host-only
destination check before sending stays as the last guard.
