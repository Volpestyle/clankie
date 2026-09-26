# @clankie/work-items

Work items in the repo's own tracking convention ([ADR 0191](../../docs/adr/0191-work-is-tracked-where-the-repo-tracks-it.md)).

- `discoverConvention(root, run)` reads what a repo already does: a Linear
  project and issue keys, GitHub issues in use, a one-file-per-item Markdown
  directory, a single `TODO.md`, decision records. It never writes.
- `resolveTracker(root, deps, { record })` returns the backend for the recorded
  convention (`.clankie/tracking.json`), or for an unambiguous discovery, which
  it records only when a write is about to happen. Ambiguity raises
  `ConventionNeededError` with the owner's one question.
- Backends: `createFilesBackend` (`default` at `.clankie/work/`, or `markdown`
  in the repo's directory), `createGithubBackend` (the owner's `gh`), and
  `createLinearBackend` (a Linear MCP tool call; the service supplies Clankie's
  connected account).
- `parseBody` / `patchBody`: the shared Markdown. Criteria are a checklist under
  `## Acceptance Criteria`, evidence a captioned link list under `## Evidence`.
  Patches touch only the sections they name, so owner-written issue bodies keep
  their other sections and order.

The service (`apps/clankie/src/work-items.ts`) owns which repos a paired device
may read; `clankie work` and the captain's `work_items` tools are its callers.
The wire shapes live in `@clankie/protocol/work-items`.
