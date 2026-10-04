# Owner-confirmed project creation foundation

VUH-1538, 2026-10-04. This is the API/CLI prerequisite for conversational
onboarding. It does not detect a newly encountered workspace, generate a role
proposal, conduct a conversation or create world stations. Those remain separate
engineering and acceptance work.

## API and commands

`POST /v1/operator/projects/create` uses the existing owner authorization boundary:
the operator credential or a paired device with current terminal control. A model
proposal, session label or workspace string supplies no authority. The strict
request contains `projectId`, `name`, `workspacePath` and `expectedRevision`, plus
optional `roles`, `workerCap`, `trackerRef` and `fleet`. The service enrolls exactly
one workspace named `primary` on `local`, with the server's platform. Remote
machine enrollment, linked roots, assignments, hires and grants are not accepted.

Read `clankie project list` for the current revision. Review a local JSON proposal,
then run:

```text
clankie project create garden --settings proposal.json --revision REVISION
```

The TUI accepts the same arguments through `/project create`. A proposal file can
contain, for example:

```json
{
  "name": "Garden",
  "workspacePath": "/absolute/canonical/workspace",
  "roles": [
    { "role": "Designer", "harness": "codex", "model": "chosen/model", "concurrencyCap": null },
    { "role": "builder", "effort": "high", "concurrencyCap": 1 }
  ],
  "workerCap": 2,
  "fleet": { "size": "small", "models": "efficient" }
}
```

The names/models are explicit owner choices, not inferred defaults. Roles retain
the existing validation and normalization. Omitted or `null` caps inherit; zero
remains an explicit zero. Empty roles inherit existing built-ins. Fleet vocabulary
is a stored preference, not a numeric cap; this slice does not wire project fleet
preferences into hiring guidance or change the existing hire counter.

Creation refuses an existing project ID. Existing `project add` behavior is
preserved: it can add a workspace to an existing project, including an explicit
owner-authored remote path through its original machine/platform flags. The new
API does not inherit that remote enrollment capability. Existing update/editor
paths remain the way to change a saved project.

## Workspace and tracker checks

The workspace must exist as a canonical absolute directory with exact spelling.
The service rejects overlap with existing workspaces or linked-worktree namespaces
on the same machine/platform. Local directory identity is captured as lossless
filesystem device/inode/birth values and checked again before commit, along with
canonical registered namespace paths. This is enrollment, not caller process proof.

An optional tracker binding is exactly:

```json
{ "workspaceId": "primary", "path": ".clankie/tracking.json" }
```

It references an existing saved convention. Reads use the existing protocol
schema, a bounded regular nonredirected file, and initial/final whole-byte and
identity checks. Missing or invalid conventions return the typed
`project_tracker_unavailable` conflict. The service does not discover or initialize
a tracker, choose accounts, call a backend or write the convention. No binding
means no convention read or claimed tracker setup. Tracker setup remains its
existing separate owner workflow.

## Commit boundary and evidence

The existing SettingsStore queue and atomic rename perform the write. The create
transform changes only the new project, preserving all unrelated settings.
Expected project revision, current owner authority, full settings snapshot,
namespace validity and directory/tracker observations are checked around the
awaited work and in the pre-rename guard. A conflict returns 409 without retry or
partial project creation. The CLI/TUI retain the proposal for review.

This is not a cross-process compare-and-swap transaction. The asynchronous guard
and final rename retain a filesystem/authority observation window; no stronger
atomic claim is made. The new code does not add another lock, registry or counter.

Tests use temporary directories and fake/temporary SettingsStores only. They cover
successful creation, legacy CLI compatibility, unauthorized/strict-field refusal,
zero/inherited caps, duplicate IDs/roles, path overlaps/aliases/replacements,
revision/settings/authority races, existing tracker preservation and changes,
concurrent creates, and shared CLI/TUI dispatch with no automatic retries. The
positive creation fixture fails against the original router's missing endpoint.
No owner configuration, live enrollment, native/model/provider/eval or app/phone
operation is part of this checkpoint. Full repository validation waits for root
review of the immutable source checkpoint.
