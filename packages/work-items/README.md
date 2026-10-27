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
The wire shapes live in `@clankie/protocol/work-items`. Owner tracker settings
use `POST /v1/operator/work-tracker`: one new-project default, or an explicit
project convention change after preview and confirmation. Existing items stay
in their original tracker. See [the CLI reference](../../docs/cli.md#work-tracker-settings).

The canonical tracker surface is the Linear-shaped subset in `tracker-tools.ts`
([ADR 0226](../../docs/adr/0226-one-tracker-tool-surface.md)). `createLocalTracker`
provides that catalog and `call(name, args)` over a durable store ([storage](#storage)), with
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

Every local read rereads the file, including changes from other processes. Each
backend reuses its last validated snapshot only when the content is identical;
changed content receives full schema and hash-chain validation. Reads return
isolated results, and writes (including cycle rollover on a read) use an isolated
store under the existing lock. Corruption remains a hard error.

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

Outcome reads for Auto rounds ([ADR 0270](../../docs/adr/0270-auto-rounds-measure-outcomes-and-name-drift.md))
live in `outcomes.ts`: closures in a window, started issues now, milestones and
status updates, and optionally state history. `collectLinearOutcomes` reads a
connected Linear project through the caller's query function with server-side
filters; the local tracker's `readOutcomes` rebuilds the same shape from its
event stream, where created and stage-family events carry the resulting
`status` name. `localDays` and `startedAtDayEnds` turn history into per-day
started counts in an IANA zone. Membership is current, which the result's
`caveats` state.

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
Delegated connected-Linear tools additionally set `linearWriteScope: "team"`:
the saved team's canonical UUID remains the write boundary, while an issue may
belong to any project (or none) in that team. An explicitly named project must
resolve to a real project associated with that team by UUID. New issues still
default to the repo's saved project. Owner-device writes keep the default
team-and-project boundary; built-in tracker scopes are unchanged.
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
Its journal shares the store's write/receipt boundary.
Each `syncId` identifies an entire commit; updates carry field deltas and
project membership before/after a move. Existing stores bootstrap at cursor zero.
See the [ADR 0226 sync amendment](../../docs/adr/0226-one-tracker-tool-surface.md#amendment-built-in-tracker-sync-journal-2026-10-09-vuh-1962)
for model fields, groups, hydration ordering and cursor recovery. This changes
neither connected Linear nor repository adapters.

Enrolled devices read saved filters using `tracker_sync` commands
`list_issue_views` and `list_issue_view_issues`. Both require the exact `project`
UUID and current `storeId`; apply also requires the saved view `id`. The backend
delegates to the normal saved-view tools under the store lock and checks live
access before dispatch and return. Results carry `outcome: issue_views` or
`issue_view_issues`, scope IDs, canonical `views` or `issues`, `hasNextPage` and
optional `cursor`. `limit` (1–250, default 50), `cursor` and `orderBy` use canonical
pagination. Definitions are never evaluated in the app or stored as snapshots.
Existing sync commits, including saved-definition writes with empty deltas, let
clients refresh their selected read without a separate poller.

`clankie work project-details --repo REPO` reads the saved tracker project’s summary, description, status, priority, lead, dates, teams, resources and latest 200 authored status updates. The latest 20 updates each carry up to 200 `replies`, flattened oldest first with author, time and parent identity. Reads use at most four concurrent comment calls and one page per update. `replyCount` is a lower bound when `repliesTruncated` is true; a failed thread read omits its reply fields without hiding the project. These fields are optional for legacy-service compatibility. Replies use the existing `save_comment` tool with `statusUpdateId` (or `parentId` for a reply to a reply), through the same account and authorization as project comments. Paired devices use the additive `work_project_details` operation. Linear and the built-in tracker share the canonical project/status-update tools. Unsupported or failed reads answer unavailable; an empty feed means a successful read with no updates. The read never infers health, author or delivery from issue state.

### Linear mirror import

`clankie work import linear --project UUID --scratch NAME` copies a single-team
project through Clankie's connected account into a separate built-in store.
Linear remains authoritative. It retains provider UUIDs and VUH identifiers,
archived records, comments/replies, state history and source actors, relations,
labels/priorities, projects, milestones, documents, updates and team cycles.
Milestones/documents participate in the existing sync protocol. Uploads enter the
evidence store and their links become `clankie://evidence`.

The importer is read-only on Linear, obeys the shared background request budget,
and compares records by provider ID/content. An unchanged rerun writes no tracker
records or events. It does not run local cycle rollover or completion gates.
Reports live in the scratch directory as `import-report.json`. External attachment
URLs are retained and reported; failed authenticated downloads abort before the
tracker replacement. Multi-team/project-to-team mappings are currently refused.

### Linear webhook mirror

`planLinearMirrorEvent` turns one signed Linear data-change event into a partial
import snapshot; `importLinear` applies it with `mirrorEvent`, so webhooks and
imports share one mapper. The store records each applied Linear event id (the
last 5,000) and returns `duplicate` on replay. Changes carry the original Linear
actor and `via: linear_mirror` on item events and enter the sync journal as
`mirror_linear`. An event naming an unknown issue, label, state or milestone plans
as drift; `collectLinearScoped` re-reads just those records with the import's
field selections. A store holding a Linear mirror refuses every built-in write
(`mirror_read_only`) until cutover.

### Cutover

`promoteLinearImport` replaces a live store with an imported copy, under both
store locks. It backs up the live bytes and marks the copy's `linearMirror.cutover`,
so the copy is writable, refuses further imports, and keeps its Linear records as
provenance. `restoreTrackerStore` puts the exact pre-cutover bytes back and keeps
the pilot store. Both keep whole stores, sync history included, and set a
replaced journal aside. `readTrackerStoreSummary` reads counts, provider record ids with
Linear's `updatedAt`, and non-Linear writes, without seeding a store.

### Storage

A store under 2 MiB is one `tracker.json`, rewritten atomically per commit. A larger
one keeps `tracker.json` as a checkpoint and appends each commit, with one fsync, to
JSONL segments in `tracker.journal/`. A background checkpoint folds the journal back
in, and the host's start-up `checkpoint()` moves an existing large file over, keeping
its bytes as `tracker.pre-journal-<ms>.json`. Open is the checkpoint plus the
journal tail, with every chain proven. Cut-over reference routing uses the backend's
host-only `referenceProjects` against its shared validated committed snapshot
(LOCAL-VUH-50). Same-process commits update that snapshot without a disk reread;
Metadata readers wait for disk publication and the shared snapshot update, including
failed appends; the fence starts after authorization callbacks to avoid deadlock.
External changes still trigger validation, and missing or damaged stores refuse.
Reference lookups reuse the committed-array indexes, extended by changed records
and appended tails. A reference rename or external replacement rebuilds the affected
metadata index; ordinary commits never reparse the checkpoint for routing. Other
host readers use `readTrackerStoreSnapshot`
(validated), `readTrackerStoreRecords` (for routing; the tracker refuses a broken
store itself) and `trackerStoreVersion`. `exportTrackerStore` writes the whole store
as one legacy file for a rollback. Design and numbers:
[ADR 0226, writes cost the change](../../docs/adr/0226-one-tracker-tool-surface.md#amendment-writes-cost-the-change-not-the-store-2026-10-27-local-vuh-42).

A write costs what it changed, not the store's size (LOCAL-VUH-47). Its draft remembers
which committed array each collection was copied from and which records it replaced
(`own`, `replaceRecord`). Settling the snapshot, the journal record and the sync
candidates read only those records and the appended tail. Receipts by key, an issue's
current bundle and owner asks, and records by id are looked up through indexes. One
index serves each line of committed arrays, and every commit extends it. Under Vitest,
every commit is also checked against whole-collection comparisons.

**Damaged journal lines.** Each line names the byte length of its record:
`{"syncId":N,"length":L,…}`. Lines without a length end at their newline. They are
older lines, or lines that a build from before framing appended after a rollback, such
as `clankie update` restarting the previous commit, so they can follow framed ones. An
unframed line after a framed one counts as a record only if it parses. Open reads
records in order:

- A final line with no newline is an interrupted append. It is left out.
- A final line whose bytes are not a whole parseable record at its stated length is also
  left out. A power cut can persist the line's size and newline but not all of its pages.
- The next append cuts either kind off.
- The same damage anywhere else refuses the open, and so does a damaged final line that
  a whole record follows.
- A live process refuses to drop a record it already acknowledged.
- A final line that still parses as a well-formed record but breaks the event, audit or
  sync chain is refused, not skipped. Its bytes are a record, so it may have been
  acknowledged.

`exportTrackerStore` validates too, so it cannot export a refused store. Recovery is by
hand:

1. Stop the service and copy the whole store directory aside.
2. If the refused line is the live segment's last, truncate the segment to the end of
   the line before it. That loses only that record. The open then proves everything
   else.
3. If the damage is earlier, restore `tracker.pre-journal-<ms>.json` with the journal
   set aside, as in the rollback below. That loses every write since the move.
4. Once the store opens, `exportTrackerStore` writes it as one file for the rollback
   steps below.

**Checkpoint size.** Open still parses `tracker.json` as one string, so V8's maximum
string length (about 537 MB) bounds it. At fleet volume that is about four months.
`clankie doctor` reports the checkpoint's size against that limit and warns at half
(`trackerCheckpointSize`). Retention or a streamed open has to land before the limit;
that is LOCAL-VUH-49.

**Rolling back to a journal build from before framing** (`f59461d17` up to
LOCAL-VUH-47) needs nothing. That build reads framed lines and appends unframed ones,
and this build reads both again.

**Rolling back to a build without the journal.** That build refuses a checkpoint, so
it needs the store exported as one legacy file. This keeps every write, including
those made since the move. It was drilled on a migrated copy of the live store: the
older build opened all of it and wrote.

1. Stop the service, so nothing else writes the store.
2. From a checkout of the journal build, export the whole store (`true` means
   written):

   ```sh
   node --input-type=module -e '
     const { exportTrackerStore } = await import("./packages/work-items/src/index.ts");
     console.log(await exportTrackerStore(process.argv[1], process.argv[2]));
   ' ~/.clankie/tracker ~/.clankie/tracker-rollback.json
   ```

3. Set the journal and checkpoint aside, and put the export in place:

   ```sh
   stamp=$(date +%s)
   mv ~/.clankie/tracker/tracker.journal ~/.clankie/tracker/tracker.journal.rollback-$stamp
   mv ~/.clankie/tracker/tracker.json ~/.clankie/tracker/tracker.checkpoint-$stamp.json
   mv ~/.clankie/tracker-rollback.json ~/.clankie/tracker/tracker.json
   ```

4. Install and start the older build.

The faster alternative, `tracker.pre-journal-<ms>.json` restored as `tracker.json`
with the journal set aside, loses every write since the move. Either single file
stops working before 60 days of fleet volume, the old format's own limit.

A `builtin` convention routes the canonical tools to the host's built-in store
through `TrackerDeps.builtIn`. That scope is the bound tracker project UUID and
its team. With scoped writes, an issue outside the project is refused.
