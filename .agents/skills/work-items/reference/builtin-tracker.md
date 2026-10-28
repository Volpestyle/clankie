# Clankie's built-in tracker

Built-in tracker mechanics for [work-items](../SKILL.md). Other backends refuse
these arguments and tools explicitly; never substitute a local store for a
failed connected call.

## Identifiers and priority

Priority is `0` (none), `1` (Urgent), `2` (High), `3` (Medium), `4` (Low).
Issue writes accept `priority`; `clankie work create` and `update` accept
`--priority 0..4`. Open-work lists sort Urgent through Low, then unprioritized,
before limiting or paginating. Local identifiers remain stable across restart.

The built-in namespace is deliberate: default new stores allocate `LOCAL-n`;
a writable store holding an imported `TEAM` allocates `LOCAL-TEAM-n` from its own counter,
starting at 1. Imported items keep their `TEAM-n` identifiers and UUIDs. The
numeric suffixes belong to separate sequences. Use the entire identifier for
reads, links, evidence and commits: `LOCAL-TEAM-2` must never become `TEAM-2`.
Do not renumber items or alter the counter to continue Linear's sequence.
Keyed create retries return the original item without allocating another number.
The supported scheme is in [docs/cli.md](../../../../docs/cli.md#built-in-item-identifiers-after-cutover).

## Writes, events and delivery

On the built-in (local) tracker, send writes with an `idempotencyKey` you choose,
unique per intended change. Retrying with the same key and arguments returns the
original result instead of writing twice; after a lost reply, read
`linear_get_write_receipt` with that key: `applied`, `refused` or `unknown`
(safe to send again). Pass the `updatedAt` you read as `ifUpdatedAt` on updates
so a concurrent change is refused (`precondition_failed`) rather than
overwritten. Records show who wrote them (`createdByActor`, `updatedByActor`,
with the on-behalf-of chain). A hired worker is named by its persona. An
agent's or outside member's record names that writer in `author`, `user` and
`createdBy`, never the local owner; `linear_list_audit_events` reads the append-only
history. You never name yourself: the host stamps your identity. Other backends
refuse these arguments explicitly.

On the built-in tracker, report progress with `linear_post_issue_event`
(`ack`, `plan`, `action`, `blocked`, `ask`, `result`, `error`) instead of setting
state by hand; the item's state is derived from it. Advance delivery with
`stage`: `ack` accepts, then `landed` when merged and `delivered` when released.
Under the owner's effective `closure: lead` policy, the host-authorized lead
may set Done after landing, relevant acceptance checks, and a checked evidence
bundle. Lead completion records its actor and bundle separately; it never sets
`owner-verified`. Workers report to the lead. Actor names, titles, project IDs,
and the ordinary CLI's operator credential do not establish lead scope: close
with the tracker tool from the project's lead conversation, never
`clankie work update --status done` from a shell. That refusal
(`owner_verification_required`) is about the route, not the policy, so changing
closure settings never clears it.
Only the owner verifies or reopens work. Under `closure: owner`, landing raises
a "check it works" ask; its answer verifies the item or sends it back to accepted.
Lead closure creates no automatic verification ask. Existing pending and
resolved asks and genuine owner-only gates retain their identities and authority.
Ask the owner to check only what he can try in the app in about ten seconds,
or what only a human can judge (feel, look, reading, sound). The lead marks it
with `save_issue` `ownerCheck`: one line, at most 160 characters; `null` removes
it. Only marked items reach his Proof deck. Workers can't set it; put a suggested
one-line check in your report to the lead instead. Never ask him to read
evidence gaps, logs or review records; the lead closes those items.
Read `linear_list_issue_events` (resume
with its cursor) for the item's history; `selfEcho` marks Clankie's and workers'
own events.

## Releases and cycles

Releases are records on the built-in tracker. `clankie work releases sync`
reads the repository's `v*` tags and assigns each release the item keys named
in its commits since the previous version: built-in keys (`LOCAL-…`) and the
convention's Linear team (`TEAM-…`). Built-in items move to `delivered` on the
first release that ships them, as a `stage` event `via: release`, when their
evidence bundle has an independent check. Imported items without a recorded
delivery stage retain release membership without a stage move. An item refusal
does not abort the sync; read `skipped` for each unchanged built-in item's version,
reason and detail. A delivery move raises
the owner's "check it works" ask under owner closure if landing has not already raised one. Linear keys
are listed by key only. Nobody types a release's items, so name the item key in
the commit message. Read releases with `linear_list_releases` (`query` also
matches an item key), `linear_get_release` and
`linear_get_issue {includeReleases: true}`, or `clankie work releases`,
`work release ID|VERSION` and `work releases --item KEY`.

Cycles are per project on the built-in tracker. The default length is one week,
and `clankie work cycle length PROJECT DAYS` changes it. The owner or the lead
plans a cycle with `linear_save_issue {cycle: "current"|"next"|N|null}` (or
`clankie work cycle add|remove ITEM`); a worker is refused. Unfinished items
roll over into the next cycle on the first access after a cycle ends.
`linear_list_cycles {project, type: "current"}`, `linear_get_cycle` and
`clankie work cycle` show each cycle's summary from the event stream: planned,
added, rolled in, removed, finished, rolled over, in flight.
`linear_list_issues {project, cycle: "current"}` lists the current cycle's items.

## Leases and runs

Pick work from `linear_list_ready_issues {project}`. These are open, unblocked,
unleased items with no active run, current cycle first, then by priority.
Take `linear_save_lease {issueId}` while you work: it lasts 30 minutes by
default, renew it before it expires, and release it with `release: true` when
done. Record each attempt with
`linear_save_run {issueId, worktree, branch}`. Finish the run with
`{id, status, tokens, costUsd, summary}`, and start a retry with
`parentRunId`. Your seat and hire are linked from your identity. Owner and lead
see `linear_list_drift` (stale leases, runs on closed items, idle items) and
`clankie work ready|drift|runs|lease`.

## Evidence bundles and independent checks

Evidence bundles and run gates are built-in tracker features. Publish
`linear_save_evidence_bundle {issueId, references, gaps, runId?}` with real store
record IDs, matching sha256 and `clankie://evidence/sha256/…` links, typed
`log|screenshot|video|diff|eval|other`. Upload bytes through the evidence store
first. Read with `linear_get_evidence_bundle`; item/run reads include their
current bundle. Completion past landed requires the item's bundle and an
independent `linear_post_bundle_check {bundleId, body?}`. Whoever did the work
cannot check it. The owner's verify answer counts as a check, and so does a
`post_owner_verdict` from the owner's own paired app (ADR 0299). No agent, the
lead included, can call that verb; never try to stand in for it. Replacing a bundle
requires another check; the owner must reopen an item past landed before its
completion bundle can be replaced. Name gaps honestly. Release sync obeys the same gate.

For a built-in native-first item's independent ISSUE check, ask an already-hired, genuinely independent peer in that same project to inspect the current issue bundle and call `linear_post_bundle_check {bundleId, body}` through its own `clankie_call`. Keep the existing producer, deliverable, holds and receipts. The peer must not have implemented the code/runtime proof, published the packet, or recorded implementation work for the item. Read the issue bundle with `runId` omitted, then read back the same current bundle's `checked` actor/eventId and the matching `bundle_checked` issue event. A run-bundle check does not replace the ISSUE check. A replaced bundle requires fresh inspection and a new check.

A native child sharing its implementation parent's bridge has that parent's tracker identity; an independent review transcript does not change it. `clankie work bundle check` records Clankie for the owner, not the peer, and is refused when Clankie published or did the work. Neither route substitutes for the peer's authenticated check. If no suitable current native peer is available, report that gap and retain the unchecked bundle. Do not create a duplicate producer, rename the deliverable, reassign a held producer, copy grants or credentials, supply an actor, or impersonate owner verification. Reconcile an uncertain native call by its original receipt ID; do not resend it.

## Asks, gates and run controls

Use `linear_post_issue_ask {issueId, purpose: "decision", body}` for an item
question. This raises the existing ADR 0245 owner ask, linked by `requestId`,
not a "Needs owner" comment. For a gate, supply `purpose: "gate"`, `runId` and
`gate: plan|spend|destructive_action|merge|external_write`. The run blocks
immediately, then the host links the mailbox ask. Only its authenticated owner
answer choosing Approve clears it; no tracker tool approves. Lead controls do
not become owner approvals. The owner and lead can use
`linear_post_run_control {runId, action: steer|pause|resume|stop, body?}`;
a worker is refused. Resume clears the pause only; stop cancels the attempt.
These are tracker events, not proof of native delivery or process termination.

CLI equivalents are `clankie work bundle set|show|check`, `work ask`,
`work gate ask` and `work run steer|pause|resume|stop`; the owner answers through
the existing `clankie conversations questions|answer` mailbox. Every
`clankie work` write, from any seat or terminal, is recorded as Clankie for the
owner, never as the owner: so the lead cannot check a bundle he published, and
the owner's "It works" is the check. Only the owner's app and his explicit
`clankie work owner` call speak as the owner; agents never use `work owner`
and reach any other tool with `clankie work call TOOL --json ARGS`. Other
tracker backends refuse these additions.

## Following changes

Orient once, then follow; do not re-list to find out what moved. Take
`linear_list_issues {snapshot: true}` (or `linear_list_ready_issues {project,
snapshot: true}`): every page reads the same moment, and each returns `syncId`
and `storeId`. Page with its `cursor`; a snapshot left unread for five minutes,
or crowded out by newer ones, says it expired: list again. Then call
`linear_list_changes {since: syncId, storeId}` and keep the returned `syncId` and
`storeId` for the next call. Each commit lists changed records by model and id,
with changed `fields` only; comment, event and run bodies are `omitted`, so read
the ones you need with `get_issue` or `list_comments`. Entering your project
reads as `insert`, leaving it as `delete`. Follow while `hasMore`. `waitMs` (up
to 20000) holds the call until a change arrives, instead of a sleep loop.
`outcome: "rebootstrap"` means the store was replaced or the cursor is ahead of
it: take a new snapshot. A hire follows its own project by default; other
projects' commits are skipped but still advance `syncId`. Naming another
project's id reads that project, as `list_issues` does; it is not a privacy
boundary. Omit `since` to start from now. Outside a hire, name `project`. CLI: `clankie work changes [--project P]
[--since N --store-id ID] [--wait SECONDS]`.

## Roles and budgets

The service gives a hired seat its role's tracker tools. The role comes from its
hire and its project's review policy, never from what it says. A reviewer and a
worker keep comments, issue events, issue creation and updates, evidence bundles
and checks, leases, runs, every read and `list_changes`. Run control, status and
project administration, owner-only review retirement and the inbox belong to
the lead and the owner, so `save_issue` `cycle`, closing an issue (a completed
`state`) and `stage: owner-verified` are refused too. A refusal is
`role_not_allowed` with your `role`, and nothing was written. Ask your lead
instead of retrying. Each hired seat has 600 requests an hour and 60 writes a
minute, counted separately for interactive calls and for `background: true`
polling. `tracker_request_budget` gives `retryAt` and `retryAfterMs`: wait until
then. `clankie doctor` and `clankie work status` show what each seat has left
and its refusals in the last hour.

## Sync

`clankie work sync --json COMMAND` reads project-scoped bootstrap/batch data,
waits for deltas from `(storeId,lastSyncId)`, or sends one keyed atomic
transaction of existing write tools. It uses the existing authenticated service
route, never a connected Linear sync. Bootstrap is JSON lines ending with model
count and cursor metadata. Apply a whole commit before persisting the cursor;
`rebootstrap` requires replacing the named groups from partial bootstrap.
Hydrate comment bodies and run details in batches, retaining newer deltas.
Use `get_write_receipt` for the original actor/key after uncertainty; replaying
that same keyed transaction returns its original outcome. New arguments need a
new key, and `ifUpdatedAt` conflicts need a fresh read. Send the bootstrapped
`expectedStoreId` with queued replays; `store_replaced` means the store was
swapped and the queued edit was not applied. Device live subscriptions
ride the existing relay tail route. Contract and command shapes live in
[docs/cli.md](../../../../docs/cli.md#work-sync---json-command).

`clankie work project-details --repo REPO` reads the saved tracker project’s summary, description, status, priority, lead, dates, teams, resources and latest 200 authored status updates. Paired devices use the additive `work_project_details` operation. Linear and the built-in tracker share the canonical project/status-update tools. Unsupported or failed reads answer unavailable; an empty feed means a successful read with no updates. The read never infers health, author or delivery from issue state.

### Sync discovery

`clankie work sync --json COMMAND` uses the authenticated tracker sync API.
Full bootstrap `projects: ["*"]` expands all tracker project UUIDs plus
`unprojected` and `workspace`; metadata `syncGroups` lists the exact IDs.
Always subscribe to `workspace` for project create/rename/archive and project-level
metadata. Discover a new project from its delta, partially bootstrap exactly its
UUID, preserve other cached groups and add that UUID to the subscription.
Use explicit settings-to-tracker UUID bindings; unmatched projects stay unbound.

## Saved issue views

Use `clankie work view save|get|list|apply|delete` for named project filters.
Name the exact `--project UUID` and `--store-id ID` on every operation.
The CLI follows `--repo` (default current git repo) and requires its current
host project binding to that built-in project; unknown or unsupported repos
refuse without a global/local fallback. Read a view
before updating/deleting, preserve its `updatedAt` with `--if-updated-at`, and use
one `--idempotency-key` per intended write. Create with
`view save --json '{"name":"Urgent","filter":{"priority":1}}'`; update by adding
the view UUID and only changed fields. Apply runs the normal current issue list;
follow `--cursor` with the same filter and use `--limit` for paging.

Canonical tools: `save_issue_view`, `get_issue_view`, `list_issue_views`,
`list_issue_view_issues` (apply), `post_delete_issue_view`. Records are version 1,
exact-store/project bound, limited to 1000 per store; names are 1–120 characters,
filters at most 8192 characters. Filters reuse `list_issues` fields, excluding
project and pagination. Store IDs come from sync bootstrap metadata; project
UUIDs come from project reads. Never infer either from a display name or reuse a
view after a store replacement. Current access is checked on every operation;
filters carry no authority or cached issues. Unsupported backends, including
disconnected Linear, refuse this capability; never substitute a local tracker.

The same enrolled-device `tracker_sync` route reads named filters with
`list_issue_views` and applies one with `list_issue_view_issues`. Send exact
`project` UUID and `storeId`, plus saved view `id` for apply. Optional `limit`,
`cursor` and `orderBy` use normal tracker pagination. Read results are
`issue_views` (`views`) or `issue_view_issues` (`issues`), with scope IDs,
`hasNextPage` and optional `cursor`. These require current chat access and
delegate to canonical current tools; saved definitions never grant authority.
Use existing sync commits to refresh, including empty-delta definition commits.
In the app, open a built-in project's Issues page and choose View. Leaving that
project or losing the pairing/store/access clears its selection. A selected
read's failure never substitutes All issues; choose All issues explicitly to
return to the ordinary list. Creation, rename and deletion stay in the API/CLI.

## Read-only Linear import, mirror and cutover

For an authorized mirror proof, use `clankie work import linear --project UUID
--scratch NAME`. It always targets a named scratch store under `tracker-imports`,
never the live tracker. Linear stays authoritative until the separate cutover.
Use Clankie's connected account only. The importer paginates archived issues and
all supported collections and obeys his background request budget; a budget
refusal names its retry time. Keep the report (`import-report.json` in the printed
scratch directory), compare counts and inspect five issue graphs and evidence
links. A rerun on unchanged source must report zero created/updated records.
Changes made in Linear during the run are legitimate updates, not duplicates.
Do not infer authorship from worker names mentioned in prose; original Linear
identity is retained when a persona cannot be proven.

To keep that scratch copy current, the owner runs `clankie work mirror linear
--scratch NAME --project UUID enable`. Signed Linear webhooks then apply through
the import mapper, once per event id, with the original actor. The copy refuses
built-in writes (`mirror_read_only`): change mirrored work in Linear until cutover.
`... status` shows counters and drift reports; drift is repaired by a scoped
re-read through the connected account. It only ever targets scratch imports.

Cutting a World project over is the owner's decision. Run
`clankie work cutover linear --world-project ID --scratch NAME --project UUID
--dry-run` first and show the plan: counts against Linear, the mirror, the store,
binding and convention changes, and the switch-back command. Without `--dry-run`
it applies the plan, and it refuses on drift or a non-empty live store. Afterwards
that project's convention is `backend: builtin`: its work is in the built-in
tracker, not Linear. Any `linear_*` call that names one of its items (`VUH-n`,
`LOCAL-VUH-n`, a UUID, or the project) reaches the built-in tracker, from any
hire, the lead or `clankie work` in any repo, with no `repo` needed. Linear keeps
only a frozen copy and is never written: a `linear_graphql` mutation or another
Linear-only write naming the item is refused with a pointer. A worker or lead
hired for that project also reaches it without `repo` for calls that name no
item. Writes outside the project are refused, and so is `linear_graphql`. A hire
whose project has no saved convention is refused rather than guessed. An explicit
`repo` always wins. To read the frozen Linear copy for history, pass
`linearHistory: true` on a read. The result is marked `linearHistory`; never
treat it as current state.
`... --switch-back [--dry-run]` restores Linear as the project's tracker and
reports the pilot writes Linear never saw. Those writes, including every
`LOCAL-TEAM-n` item, then exist only in the kept pilot file, never in Linear.
Show the owner that count before a switch-back.

## Checkpoint capacity and rollback

Large built-in checkpoints stream open record by record; all schema and history
chain checks still apply, and history is not expired. The JSON layout is unchanged.
External journal appends hash before decoding and replay only the tail when the
checkpoint is unchanged; same-process publications reuse the committed snapshot.
Doctor's checkpoint warning measures headroom for an older runtime's whole-file
string parser, not this runtime's open ceiling. A previous build refuses oversized
checkpoints before writing; keep a streaming build available. The full store still
needs memory, and individual records and legacy export/cutover still have string
limits. Journal damage recovery and rollback steps live in
[the storage reference](../../../../packages/work-items/README.md#storage).
