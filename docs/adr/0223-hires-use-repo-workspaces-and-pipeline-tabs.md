# ADR 0223: Hires use repo workspaces and pipeline tabs

Status: accepted (2026-10-04; VUH-1550, landed in `4384b34b`).

Extends the placement preference in [ADR 0216](0216-projects-own-agent-roles-and-tool-policy.md).
Implements [VUH-1550](https://linear.app/vuhlp/issue/VUH-1550).

## Context

An implicit `tab create` followed the lead's Herdr workspace. Independent hires
across repos accumulated in one workspace, while `split` meant beside the lead
rather than beside stages of a shared workflow. Client focus is neither repo
identity nor an instruction to group independent workers.

## Decision

Allocate new hires into one workspace per repository within the selected Herdr
fleet/session. Ask that machine's Herdr CLI for Git's `repo_key`; linked worktrees
share the repository identity. Repository basenames are display labels, never
identity. Outside Git, use the exact approved working directory.

Prefer existing native worktree membership or Clankie's workspace identity
metadata. A hand-created workspace without either is reusable when every pane's
observed directory resolves to the same repository. A mixed legacy workspace is
not a repo workspace. Choose the primary checkout workspace before a linked one,
then the oldest workspace when existing duplicates require a deterministic choice.
Do not merge duplicates or rename existing workspaces. Create and name a missing
workspace once, with its initial root tab reserved separately as `Clankie`.

Updated 2026-10-08 for [VUH-1869](https://linear.app/vuhlp/issue/VUH-1869):
omitted placement fills named 2x2 worker tabs, at most four per tab, before
opening the next numbered tab. Positions fill top-left, top-right, bottom-left,
bottom-right. A project or deliverable names the group; without either, use
`repository workers`. Per-hire `pipeline` overrides that group name. Explicit
`new-tab` retains a solo `Name · role` tab; explicit `split` requires a pipeline.
Owner/role/fleet placement overrides keep their precedence.

Each grid pane carries a `clankie_grid=2x2` version token alongside repo/group
identity. Older pipeline tabs are not adopted or rearranged. Allocate the next
position by splitting a verified worker leaf at ratio 0.5: right of the first,
below the first, then below the second. This fills positions right/down/right
without creating narrow leaves inside the left column. Read the native layout,
not focus or snapshot pane order, to find the target. A changed layout refuses.

Pipeline grouping requires both matching repo and pipeline metadata on every
existing pane in the named tab. Ambiguous names and unmarked tabs refuse; no
focused-pane, lead-pane or terminal-typing fallback exists. Herdr metadata values
are limited to 80 characters, so identity tokens contain SHA-256 digests, while
full workflow names remain tab labels. Metadata establishes layout membership,
not project grants, hiring ownership or native control authority.

Pass the selected workspace explicitly to both CLI `tab create` and native
initial-command `layout.apply`. Serialize new allocations within a bound runner and the fleet router, whose
bound runner factories refresh per call.
Keep client focus. Rename and mark only panes created by the new allocation.
Prepared native Pi/OpenCode/Grok launches create an initial-command pane in a
new temporary tab, then move only that newly allocated pane into the group.
The native terminal/process survives and the empty temporary tab closes.
Never rebuild a tab with existing processes. Same-tab `pane move` silently does
nothing; sub-leads have exact commands and the out-and-back workaround in the
[worker grid guide](../../.agents/skills/clankie/reference/worker-layout.md).
A failed/unknown create, move or metadata reply retains an uncertain allocation,
not a replacement pane.

A live-session resume reuses its existing pane without rearrangement. A resume
that needs a new pane, or the destination allocation of an explicitly requested
move, uses this same rule. A move carries the known worker role and allocates a
solo tab at the destination: that API names a destination, not a shared pipeline
enrollment. Resumes retain their temporary session-specific pane
label until native identity is observed, preserving uncertain-resume fences while
the tab carries the human name/role. This change never migrates, closes or renames
existing lanes. Native subagents remain inside their harness, not new Herdr panes.

## Evidence and limits

Following [ADR 0221](0221-tests-prove-the-product-and-its-boundaries.md), the
integration journey uses actual Git repos/worktrees and a real Herdr CLI/socket
in a private throwaway session, with private HOME/config and no model hire.
It exercises the request schema, placement runner and prepared native socket
consumer: focus-independent reuse, equal repo basenames, long repo/workflow names,
concurrent solo allocations, pipeline stages and refusal of unmarked shared tabs.
Lost replies after real tab creation or pane labeling retain an uncertain hire
receipt across store recreation and prevent a second allocation or harness start.
It preserves the unrelated and mixed lanes' pane/tab identities and cleans up
only the session created by the test. Existing hire/resume/fleet tests cover the
request forwarding and reuse paths. This is placement integration evidence,
not a claim that a fresh authenticated harness completed a model turn.

Existing mixed fleets stay as they are; an owner may arrange them separately.
Unknown or missing pipeline metadata refuses rather than reconstructing ownership.
Concurrent allocations by separate Clankie services are not a distributed lock;
the supported fleet has one allocating controller. Unknown native creation must
be inspected before retrying, rather than allocating a replacement pane.

VUH-1869 extends the real-socket journey with five allocations, exact 2x2
geometry, numbered overflow, prepared initial-command joining and preserved
foreign lanes. Its [live evidence](../testing/2026-10-08-worker-layout/README.md)
uses only newly created throwaway panes in the owner's running session.
