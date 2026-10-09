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
  in the repo's directory), `createGithubBackend` (the owner's `gh`, or `githubRestApi` with the
  body's GitHub account connection, ADR 0232), and
  `createLinearBackend` (the service supplies Clankie's connected account through
  its registered API adapter or the separately configured Linear MCP connection).
- `parseBody` / `patchBody`: the shared Markdown. Criteria are a checklist under
  `## Acceptance Criteria`, evidence a captioned link list under `## Evidence`.
  Patches touch only the sections they name, so owner-written issue bodies keep
  their other sections and order.

The service (`apps/clankie/src/work-items.ts`) owns which repos a paired device
may read or write; `clankie work` and the device API remain compatibility callers.
The wire shapes live in `@clankie/protocol/work-items`.

The canonical tracker surface is the Linear-shaped subset in `tracker-tools.ts`
([ADR 0226](../../docs/adr/0226-one-tracker-tool-surface.md)). `createLocalTracker`
provides that catalog and `call(name, args)` over a durable `tracker.json`, with
atomic locked writes, stable UUIDs and human identifiers. The service exposes
these as `linear_*` through the same MCP host and fleet directory used by
connected Linear. No connection selects local storage; connected provider
failures retain their errors and never replay locally. `clankie doctor` reports
selection and reason. Repository adapters keep GitHub/Markdown issue storage
and carry ancillary records in durable local metadata within that scope.

The local store also records the host-stamped actor (`TrackerToolCallOptions.actor`)
on every write, keeps per-actor `idempotencyKey` receipts and a hash-chained
audit log in the same atomic replacement as the effect, and refuses stale
`ifUpdatedAt` updates. `get_write_receipt` and `list_audit_events` read them.
Other backends refuse these inputs explicitly (ADR 0226 amendment, VUH-1916).

Evidence bundles hold validated store references and gaps on items and runs.
Completion past landed requires the current item bundle and a `bundle_checked`
event from an actor who did not do the work; the owner's verification counts.
The host supplies `validateEvidence` from its evidence store. Item asks and run
gates use the existing ADR 0245 mailbox; tracker records hold only its references.
A gate blocks a run immediately until the authenticated owner answer approves it.
Owner/lead steer, pause, resume and stop are events. See the
[VUH-1919 amendment](../../docs/adr/0226-one-tracker-tool-surface.md#amendment-evidence-bundles-owner-asks-and-run-gates-2026-10-09-vuh-1919)
for tools, recovery and scope.

Hosted registered OAuth selects the service's in-process GraphQL adapter with
broker entry `linear-api` ([ADR 0232](../../docs/adr/0232-hosted-connections-use-the-body-broker.md)).
It retains account/repository/fleet fences and mutation receipts, and never
passes that token to MCP. Disconnect clears both API and legacy MCP credentials.
Optional customer-needs/releases expansions and unsupported provider mutations
refuse explicitly. Description patches reread the stored body but cannot provide
provider-wide compare-and-set; media-bearing description edits refuse, so add
evidence in a comment instead.

Priority is native Linear `0..4`, Markdown `priority:` front matter and reserved
GitHub priority labels. Open-work listing sorts Urgent→High→Medium→Low→none
before limits and pagination. CLI create/update accept `--priority 0..4`.
Export/import execution is deferred; the ADR specifies the identity mapping and
uncertain-write reconciliation needed to avoid duplicate imports.

`update` accepts `addLabels`, `removeLabels` and `addDependsOn` deltas. Each
backend reads the item afresh and merges against its complete native metadata;
the 20-label `WorkItem.labels` display projection never supplies a replacement
label set. Existing labels keep their names and order, removals win, and repeated
additions are ignored case-insensitively. Dependencies merge with existing
prerequisites. `owner` is the shared body/front-matter work owner, including
`null` to clear it; it does not reassign the tracker issue's native assignee.
An update prepares all changes before one provider mutation or atomic file rename.
Its returned item retains the backend's parent metadata.

`scopedWrites: true` opts into the owner-device write boundary. Linear resolves
the recorded team/project through connected reads and compares canonical UUIDs
with the fresh item's `teamId`/`projectId`; display names alone never prove scope.
GitHub issues stay in the recorded repository, and scoped label deltas cannot
manipulate labels recognized by its status parser, including `doing`/`wip` aliases.
Files reject symlinked work paths, including
parents and items, and reobserve the destination immediately before publication.
Existing generic agent backends keep their unrestricted behavior unless this
option is enabled.

Backend options and `TrackerDeps` expose synchronous `beforeWrite`, `onDispatch`
and `effectConfirmed` callbacks. Files run the final fence after temporary-file
IO and before rename. Successful provider writes report confirmation before
follow-up reads, so a failed parent/result read cannot erase proof of the effect.
When a connected adapter awaits credential or admission checks, the service
places its final fence and dispatch observation at that adapter's actual send
boundary; it does not infer dispatch from an earlier backend callback. These
hooks are service-owned authority and receipt integration, not caller-supplied
permissions or an automatic retry path.

Linear lists use cursor pages of at most 50 issues, stopping at the requested
number of matching items (default 100, maximum 250) or the final page. Missing
or repeated continuation cursors fail with `invalid_pagination` instead of
looping or silently returning an incomplete list.

A saved Linear convention may include `linear.label`, an existing label that
scopes the repo's board within its team/project. Every provider page receives
that filter; an ad-hoc role label is intersected against the provider's full
labels before the item's 20-label display projection. Status and owner filters
still apply. Omitting the saved label keeps the team/project-wide board.
Creates carry that label; edits and attachments preserve existing labels.
Direct known-item reads remain available: the scope is a board filter, not an
authorization boundary. Unknown labels fail at the provider; none are created.
Attachments beside uploaded media insert only new evidence, refusing ambiguous
Evidence headings instead of replacing upload nodes.

The service requests MCP `resultMode: "data"`: complete text up to 8 MiB in
UTF-8, with typed `result_too_large` failure above that ceiling. The default
model-facing 50,000-character cap is unchanged. The data limit is checked on
the decoded tool result; it is not a network transport streaming limit.

## Built-in sync

`LocalTrackerBackend.sync` adds project-scoped full/partial bootstrap, lazy
batch hydration, resumable pushed commits and keyed atomic transactions.
Its journal shares `tracker.json` and the existing write/receipt boundary.
Each `syncId` identifies an entire commit; updates carry field deltas and
project membership before/after a move. Existing stores bootstrap at cursor zero.
See the [ADR 0226 sync amendment](../../docs/adr/0226-one-tracker-tool-surface.md#amendment-built-in-tracker-sync-journal-2026-10-09-vuh-1962)
for model fields, groups, hydration ordering and cursor recovery. This changes
neither connected Linear nor repository adapters.

`clankie work project-details --repo REPO` reads the saved tracker project’s summary, description, status, priority, lead, dates, teams, resources and latest 200 authored status updates. Paired devices use the additive `work_project_details` operation. Linear and the built-in tracker share the canonical project/status-update tools. Unsupported or failed reads answer unavailable; an empty feed means a successful read with no updates. The read never infers health, author or delivery from issue state.
