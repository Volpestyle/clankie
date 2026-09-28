---
name: herdr-lead
description: Lead an authorized fleet through Herdr when explicitly selected or Swarm integration is unavailable. Uses lead for shared leadership judgment; a status question alone does not authorize dispatch.
---

# Herdr lead

Load `lead` for ownership, dispatch judgment, review and delivery. For enrolled
Swarm peers, use `swarm-lead` by default. Use this workflow when explicitly selected
or the relevant agents lack Swarm integration; name that fallback once. Do not send
the same assignment through both transports.

Load `herdr` for the CLI; prefer `herdr --skill` from the running binary. A
socket-attached lead uses its configured socket and explicit pane identity, never
the UI-focused pane. Use `herdr-handoff` for a real context transfer.

## Dispatch and receive

Create a worker in its own named tab in the lead's workspace by default, preserving
the working directory and the user's focus. Reuse existing owners where they are.
Before an assignment or scope change, use [roles and effort](reference/roles.md)
to verify the actual model and effort. Set both on launch; changing `/model` in a
running pane can rewrite the user's global default.

Read the receiving pane's full visible composer immediately before every send.
Idle/done does not establish an empty composer. Preserve drafts, questions, menus
and history views; wait for the operator to finish, then read again. Never clear or
submit their input. Use [dispatch and waits](reference/operations.md#dispatch-and-waits)
and confirm pickup once.

One harvest owner holds the completion watcher. Use the
[watch sequence](reference/operations.md#watch-dispatched-work); Clankie's service
uses its own `herdr_watch` wake path. Completion is a cue to inspect the artifact,
not acceptance. Do not read pane output on a timer.

## Terminal ownership

Close only panes you created or the user identified for cleanup. Preserve ignored
evidence and check actual producers before closure; a missing TTY or separate
process group does not prove that descendants survive the pane. Never remove a
sibling's worktree or branch. Use `shared-checkout` when committing alongside
other writers in one checkout.

Open the optional fleet board or rearrange terminals only when requested; see
[terminal operations](reference/operations.md#organize-the-session-after-approval).
The board is a view of work, not a second authoritative queue. Optional
[operations](reference/operations.md) and [durable trackers](../lead/reference/durable-trackers.md)
are references for a named need.

When leading Clankie's swarm, use the owner-connected tracker identity for every
tracker write, including hired workers. Use Clankie's connected tools or an
explicit worker grant; a worker without access asks the lead to make the write.
Never substitute the harness's own connector or a fixed account.
