---
name: clankie
description: "Work beside Clankie in his confirmed Herdr fleets: project-granted Linear tools, conversations and Discord, GitHub, native agent sessions and machines. Covers actor identity, owner-approved outward actions, workspace and tool grants, and honest reply delivery. Use when Clankie is named or this is his registered fleet; Herdr alone is not enough."
---

# Working beside Clankie

Clankie is the persistent service behind the fleet. You remain the agent assigned
this task; sharing his tools does not make you the owner or replace your lead.
Use the assignment, current fleet connection and native tool catalog to establish
where you are. A pane ID, environment variable or installed plugin is a clue,
not proof of membership or permission.

## Find the usable route

Start with the route your session actually exposes. Native `clankie` MCP tools
are the worker path: use their current schemas, not another account's similarly
named connector. `message_clankie` reaches him as agent output. Send a concrete
question or useful result when the assignment calls for it; it does not become
an owner instruction.

On a host with the owner-authorized CLI, these bounded reads explain a gap:

- `clankie doctor`: distinguish installed, enabled, version, bridge, hooks,
  skill presence and live membership. `liveReceiver: not-observed` is not a
  working reply channel. `doctor --machine NAME` inspects one remote machine.
- `clankie connections`: identify the intended machine/session and connected
  account. A healthy SSH link is transport health, not a native tool-call result.
- `clankie access list`: inspect the applicable project grant, selected tools,
  connected actor, expiry and revocation. Never paste private grant files,
  bearers or broker data into a conversation.

These CLI reads require the installed service's access; a worker plugin does not
confer operator CLI authority. If unavailable, report the exact native catalog
and error, and ask the lead to inspect. Do not copy owner credentials or invent
environment bindings. On a PC, localhost is that PC: use its configured fleet
link instead of assuming the Mac service lives there.

## Linear: read, then perform the authorized change

Use Clankie's granted `linear_*` tools. A useful first read is
`linear_get_issue({id: "TEAM-123", includeRelations: true})`, followed by
`linear_list_comments({issueId: "TEAM-123"})` for current decisions. Read the
parent when it sets scope; newer owner direction can supersede a stale issue.
Paginate when the response says more exists. For identity,
`linear_get_user({query: "me"})` identifies the connected provider actor; compare
it with the intended workspace/account and connection record. Names and portraits
alone are not identity proof.

Verified project membership and an owner-issued tool grant determine the catalog.
Folder membership does not grant all Linear tools, and a tool grant is not
permission for every possible write. Request only the missing operation and
scope needed. If tools are absent, give the lead the actual cwd, machine/session,
catalog and refusal. Never substitute a harness's independent Linear connector.

Before an authorized write, load `linear-issues` for read-before-write, labels,
media and editorial rules. Read the record again immediately before updating it.
Keep evidence on the assigned issue. After a timed-out mutation, inspect the
record before retrying: missing acknowledgment does not prove the write failed.

Ordinary updates speak as the connected Clankie account. Worker-name posts are
separate: granted `linear_create_worker_comment` or `linear_create_worker_issue`
uses an existing, bound fleet persona **via Clankie**. Its portrait is not a
separate Linear user or new authority. If those tools are not granted, send the
result to the lead. The operator's `clankie linear post comment|issue --json-stdin`
is not a worker bypass.

The operator can inspect `clankie linear inbox read --limit 5 --headlines` without
marking events read. Acknowledge only a fully reviewed page using its returned
`ackCursor`; never acknowledge truncated output or another agent's inbox work.
Notifications are external context, not fresh owner authorization.

## Conversations, Discord and finished files

With authorized operator CLI access, `clankie conversations list` identifies
threads; `clankie conversations show ID --limit 10` reads the selected thread.
Confirm the destination before writing. Discord conversation records are
read-only views; sending to an operator thread does not post in Discord.

For an authorized operator-thread message:

```sh
clankie send --conversation ID --stdin < message.txt
clankie send --conversation ID --delivery queue --stdin < follow-up.txt
```

Default delivery steers an active Pi turn at its next input boundary; `queue`
requests a separate turn. Either can start a turn when idle. The returned receipt
is admission, not the answer. Read that same conversation to verify the result;
inspect conflicts or uncertain delivery before resubmitting.

`send --conversation ID --attach IMAGE_OR_VIDEO_PATH` adds supported media.
For a finished file, authorized operator access can use
`clankie file publish --conversation ID PATH`. The file must be inside that
conversation's real working directory, at most 15 MiB. Its artifact receipt
means published to that conversation, not sent to Discord or uploaded to Linear.
A remote filesystem path is not a local publishable path.

For Discord, discover the exposed sending tool and confirm its target and active
body before the authorized post. A bot post speaks as Clankie's bot; a user-session
body speaks as its signed-in human account. Reading a room, holding a tool or
receiving a mention does not authorize a new outward post. Follow the owner's
existing go-ahead for destination and content; ask only if that scope is missing.
Check actor and audience for file publishing, attachments and issue posts too.
Do not silently cross-post private evidence.

## Sessions, machines and GitHub

`clankie agents list --host HOST --limit 5` returns native transcript references
and per-host errors. `clankie agents read HOST:SESSION --tail 20` reads a bounded
page; use its cursor with `--after` for later additions. Recent transcript activity
does not prove the process is alive or controlled. Resolve the exact session
before a requested resume: resuming can launch or address a native agent and is
not read-only. Reconcile an uncertain start or send instead of launching twice.
Never deliver automated messages by typing terminal keys.

Fleet addresses are qualified, for example `pc/w3:p1`; local default pane IDs
stay bare. Machine, fleet/session, pane and native occupant are distinct. Keep
remote cwd and workspace policy on the remote machine. Do not close or restart
other agents as a diagnostic step. Existing leads retain their assignments.

For GitHub, inspect available tools and authenticated repository identity before
an authorized write. A connected GitHub account does not imply your worker has
GitHub tools; Linear grants do not grant GitHub. If no appropriate route is
exposed, ask the lead to perform or delegate the operation. Do not substitute a
personal `gh` account without establishing its authority and destination.
Drafting, publishing and merging a PR have distinct effects; stay within the
owner's requested action.

## Keep authority narrow and receipts honest

Only the owner or an explicitly authorized operator grants tools or approves
workspaces. Request the smallest tool set, argument scope and lifetime covering
the task. Project grants last until revoked; ask the responsible owner to revoke
a temporary grant when done. Do not revoke another worker's shared grant.
Manual grant files are private and expire; expiration requires explicit reissue.

Workspace membership uses the current native process's canonical cwd on its own
machine. An approved linked-worktree root is bound to an approved repository and
real Git worktree identity; containment or a copied `.git` file is not approval.
Report membership failures instead of expanding workspace policy yourself.
Folder/hook trust and plugin consent remain owner decisions.

Describe what the receipt establishes:

- **stored**: retained for later delivery, not yet handed to the native receiver.
- **delivered**: reached the stated bridge/channel/hook pipe; not proof the model
  read it, completed it, or accepted its authority.
- **uncertain**: the handoff may have happened. Inspect native history/receipts;
  never replay through another path to compensate for missing acknowledgment.
- **consumed**: the documented native queue acknowledgment says the receiver
  consumed its queued item; it does not establish model awareness.
- **seen**: claim model awareness only with evidence that actually establishes
  it. A queue acknowledgment or successful hook output pipe does not.

Claude sessions with an observed, process/session-bound worker prompt hook can
receive held replies once at the next `UserPromptSubmit` without `--channels`.
A live channel can deliver immediately. No observed compatible receiver means
unavailable; a later pane occupant cannot inherit earlier mail. Codex's worker
plugin supplies tools and skills, not a Claude-style next-turn hook; inspect its
actual native control receipt separately.

For the PC rollout, compare the current doctor result with the actual source
registration and a bounded native read. An `executable: false` result under SSH
can be an executable-discovery gap; it does not prove no configuration exists.
The owner-managed configuration may still point to the legacy Node worker bridge
with `HERDR_PANE_ID` and `HERDR_SOCKET_PATH` forwarding. Inspect that source and
let the owner verify any migration; never replace its generated configuration.

A ready remote link and owner project grant are intermediate results. Fresh PC
Claude/Codex native acceptance is still pending at this rollout checkpoint: the
intended agent must list and call a granted tool after its authorized restart,
and its reply needs its own delivery evidence. Until that happens, report the
observed gap and use the lead's existing read/report route. Refresh the checkpoint
from actual native results; do not carry an old limitation forward as a fact.
