# ADR 0305: Connected apps write the owner's issues as agents, under the posting setting

Status: Accepted, 2026-10-30, as part of the connector work James asked for
(issue files as the default tracker, Linear and GitHub as choices). Amends
[ADR 0301](0301-claude-reaches-the-fleet-through-a-narrow-connector.md); builds on
[ADR 0302](0302-posting-to-your-tracker-is-the-owners-call.md) and
[ADR 0304](0304-the-owner-hands-the-lead-to-connected-apps.md).

## Context

ADR 0301 let a connected app read the owner's projects and their issues
(`list_issues`, `read_issue`) and kept every tracker write off the connector.
Once the owner can hand the lead to the connected apps (ADR 0304), the lead
files and updates issues as part of leading, so an app that leads needs to
write them. ADR 0302 already says who may post to an outward tracker; the
connector should take that path, not a new one.

## Decision

The connector gains two tools, `save_issue` and `comment_issue`, served by one
op, `issue_write`.

- **An agent acting for the owner, never the owner.** The service writes as
  `{type: "agent-worker", id: "app:<deviceId>", name: <approved app name>,
onBehalfOf: [owner]}`. The owner's own writes (his app, `clankie work owner`)
  are never held, so an app must not look like them. The relay stamps the
  authenticated connector device (`400 issue_write_app_is_stamped` for a
  caller-named one, `403 connector_device_required` for any other device), and
  the service accepts the stamp only from the relay's captain lane and only for
  an active connector device, as for `prompt_answer`.
- **The project's posting setting decides Linear and GitHub.** The write goes
  through the canonical tracker tools (`save_issue`, `save_comment`) and the
  same posting check as any other agent's:
  - Read only refuses it.
  - Ask me holds it as a check in the owner's feed, naming the app.
  - Clankie decides lets it go while the owner has handed the lead to the
    apps, and otherwise holds it for Clankie, who leads. (Amended by
    [ADR 0335](0335-connected-apps-post-under-clankie-decides.md): it lets an
    app's write go whoever leads.)
  - Go ahead lets it go.
    A held write answers with the post's id; nothing reaches the tracker until
    someone approves it, and an approved post goes out as the posting replay
    does today.
- **Private issue files are written right away.** They never leave the Mac, so
  ADR 0302 leaves them writable. Issue files hold no comments; `comment_issue`
  on them is refused with a pointer to the issue's description.
- **Only the owner's projects.** A Linear project `list_issues` shows only because
  it is in the connected account (`linear-<uuid>`) belongs to none of the owner's
  projects, so no posting setting covers it; apps read it and never write there.
- **A status lands in the team's own state.** For Linear, the service reads the
  team's states and picks one by type, as the Linear backend does, so a team that
  calls its states Ready, Doing or Complete still gets the right one.
- **Small, typed writes.** `save_issue` creates (`title`, optional
  `description`, `status`, `priority`, `labels`) or updates (`issue` plus any
  of `title`, `description`, `status`, `priority`, `addLabels`,
  `removeLabels`); `comment_issue` adds a comment. Text is at most 20,000
  characters. Nothing else in the work service (claims, links, moves,
  deletes, the owner's own `work_item_write`) is open to a connector.
- **An unclear end is said plainly.** When a tracker call fails after it may
  have reached the tracker, the answer is `uncertain` and tells the app to
  read the issue before trying again, so it isn't written twice.

## Consequences

- An app the owner trusts with the lead can keep a project's issues current
  without the owner at the Mac, and the owner's per-project setting still
  bounds Linear and GitHub.
- While the apps lead, a hired worker's write on a Clankie decides project
  still waits for Clankie; an app can't approve or send back held posts yet.
  That is the next step if the apps lead for long.
- Ask me checks name the app, so the owner can tell an app's write from
  Clankie's or a worker's.
