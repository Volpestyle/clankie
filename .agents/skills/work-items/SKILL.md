---
name: work-items
description: >-
  Use when you create, update, close, comment on or report tracked work in a
  repo: issues, acceptance criteria, status, evidence, result and project status
  updates, or a handoff. Tracks work where the repo already does (Linear, GitHub
  issues, its own Markdown directory, Clankie's built-in tracker) and in
  .clankie/work/ only when it has nothing. Covers read-before-write, where each
  kind of work state lives, what status means, and how to write a post that
  carries only what a reader cannot re-derive.
---

# Work items

Track work where the repo already tracks it. Never impose a tracker on a repo
that has one (ADR 0191). Use tracking only when the user or project workflow
calls for it; an available tracker is not a reason to create ceremony.

## The contract

`clankie work` is the same for every agent here, whatever the backend. Run it
from inside the repo (or pass `--repo PATH`); output is JSON.

| Need                           | Command                                                       |
| ------------------------------ | ------------------------------------------------------------- |
| How does this repo track work? | `clankie work` (discover: signals, convention, or a question) |
| Record the answer once         | `clankie work init` (discovered) or `init --backend B ...`    |
| What is open?                  | `clankie work list --status todo,in_progress`                 |
| One role's backlog             | `clankie work list --label designer` (case-insensitive)       |
| One item                       | `clankie work show ID`                                        |
| What happened on it            | `clankie work activity ID` (comments, state changes)          |
| New item                       | `clankie work create "Title" --criterion "..." --owner NAME`  |
| Progress                       | `clankie work update ID --status in_progress --check 1`       |
| Finished                       | `clankie work close ID` (`--canceled` if dropped)             |
| Evidence                       | `clankie work attach ID --url URL --caption "what it proves"` |
| Review a local Git change      | `clankie work review-diff BASE HEAD` (read-only, two commits) |
| Review a supplied patch file   | `clankie work review-patch FILE` (patch claims only, no Git)  |

Statuses: `backlog`, `todo`, `in_progress`, `in_review`, `done`, `canceled`.
Label an item with a role name (`designer`, `builder`, …) to put it on that
role's station in the owner's world. Criterion numbers are 1-based. Clankie and
workers use the same `linear_*` tracker tools on every backend, discovered through
`mcp_tool_search` or `clankie_tools`; a `repo` argument selects that repository's
convention. `clankie doctor` reports the active backend and why. Use the full
identifier everywhere: a built-in `LOCAL-…` key never becomes another tracker's key.
For an item `clankie work ready --project P` lists, pass that same `--project P`
to `show`, `activity`, `update`, `close` or `attach`. Without it they use the repo
you run from, which may be Linear. An item of a project cut over to the built-in
tracker always goes there, from any repo or tool. Linear holds only its frozen
copy; read that copy only with `linearHistory: true`.
Issue summaries have no separate 20,000-character limit: `work create --summary`
matches canonical `save_issue` descriptions, and `work show`/API reads return
the full summary. Provider and transport request limits still apply.

Backend specifics: [Linear](reference/linear.md) (data-destroying mechanics,
media, threading, worker posts) and [built-in tracker](reference/builtin-tracker.md)
(idempotency, events, leases, runs, evidence bundles, cycles, releases, sync,
import and cutover). Project facts, project settings, narrow owner writes and seat
retirement bookkeeping: [projects and seats](reference/projects.md). To read a
project or issue before working, load `work-orient`.

Owner verification and owner ask answers belong to the owner. Never use
`clankie work owner` or answer as the owner. The shared operator bearer still
permits those calls from a same-user shell; that is a known boundary gap, not a
secure distinction ([ADR 0253](../../../docs/adr/0253-owner-confirmation-needs-an-isolated-authority.md)).
Report missing isolation honestly and keep owner-verified acceptance open.

## Rules

1. **Discover before creating.** If `clankie work` returns a `question`, the
   repo tracks work in more than one place or only in a single `TODO.md`. Ask
   the owner (or your lead) once, then record the answer with
   `clankie work init --backend ...`. Never pick silently.
2. **Settings use the same tracker.** `clankie fleet tracker` reads the default
   for new projects; `clankie project settings PROJECT` reads the saved project
   choice. Add `tracker JSON` to propose a project change, then apply the exact
   preview with `--revision REV --confirm-retain-items`. For the new-project
   default, use `clankie fleet tracker JSON --revision REV`. The TUI accepts the
   same arguments through `/fleet tracker` and `/project settings PROJECT tracker`.
   Existing items stay in the old tracker; nothing migrates or is deleted. Linear/GitHub use connected
   accounts; built-in and repo files need none. See the CLI's Work tracker settings.
3. **Follow what is recorded.** `.clankie/tracking.json` is the owner's answer.
   Do not create `.clankie/work/` files in a repo whose convention is Linear,
   GitHub or its own directory.
4. **Every result carries evidence; prefer real visuals.** Screenshots or short
   clips of tangible results, charts of measured data and diagrams of the actual
   system, also for headless work. Inspect visuals before attaching them; caption
   what they show, their source or revision and what they establish. Label
   proposals, sample data and unverified states. Before reporting work finished,
   attach decisive test output, numbers and commit links. Embed media inline where
   people read (comment, description, status update), not only as an attachment.
   Raw captures (media, large JSON and logs) go under `docs/testing/<folder>`:
   write its README, run `clankie evidence push <folder> --issue <KEY>` (or
   `evidence_push`), commit only `README.md` and `evidence.json`, and cite the
   printed `clankie://evidence/sha256/...` links. A tracker upload may display a
   screenshot, but the evidence-store copy is the record. Listing, key inference
   and backfill: `docs/cli.md` under `evidence push|fetch`.
   Local storage remains the default. Self-hosted S3 keeps its SDK credential
   chain. Managed evidence has only a default-off scoped broker/provider seam;
   its private injected issuer is unmounted, with no production transport or
   activation. Missing managed admission refuses; never repair it with owner
   AWS credentials, settings secrets or another destination. Historical reads
   retain their recorded destination and need its own read authority. Offline
   MinIO proof is not hosted STS/IAM/revocation proof; cloud work, startup and
   owner activation need separate authorization (ADR 0297).
5. **One owner per item.** Set `--owner` when you take an item; do not edit an
   item another agent owns without telling them.
6. **Keep it small.** Status, criteria, ownership and evidence only. No sprints,
   estimates or extra workflow.

For a bug investigation where a tracker is in use, search in-progress and recent
closed items for the symptom or related changes before forming a code hypothesis.

## The tracker is the source of truth

People edit items outside this conversation. **Assume every difference between
what you remember and what the tracker holds is intentional.**

- **Read immediately before each write**, not once at the start of the task, and
  base the new text on what you just read, not on your own earlier draft.
- **Their edit wins, even when it reverses something agreed.** Do not restore a
  dropped label, revert a changed priority or re-add deleted text unless asked.
- After a timed-out write, inspect the record before retrying: a missing
  acknowledgment does not prove the write failed.

## Write within the authorized scope

The tracker holds durable product, engineering and design work, decisions and
evidence. A mandate to lead and keep work tracked covers routine evidence, status
and current-document maintenance within that work; do not ask again for each
write. A request to draft, review or suggest stays a draft: editing a draft does
not authorize sending it, while "reply with…" in an authorized posting task does.
Ask only when an action exceeds the mandate, such as a new external commitment or
a tracker restructuring the user reserved. Tracking authorized work does not
authorize expanding its scope.

## Where work state lives

This is the handoff protocol for every agent here, lead and workers alike,
whatever the backend. Each kind of state has one home, so a fresh seat, a lead
after a reset or the owner can pick work up cold from the item:

| State                                                                                            | Home                                                                    |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Status, what landed (commit), evidence, remaining acceptance, decisions                          | The work item in this repo's tracker                                    |
| Briefs, questions, reports, "done at SHA"                                                        | Agent messages (`message_seat`, `message_clankie`)                      |
| Code and committed evidence                                                                      | The repository, linked from the item                                    |
| Seat-swap machine state: worktree, uncommitted or unpushed changes, background jobs, local paths | `.local/HANDOFF-<name>.md` in the owned worktree, linked from the item  |
| Fleet-wide state across items                                                                    | A project status update (`linear_save_status_update`, on every backend) |

- A message is never the only copy of something needed later; put it on the item.
- Pane assignments, leadership transfers, usage limits and queue coordination
  stay in agent messages or the worktree handoff, never in issue comments.
- A worker that cannot write the tracker sends the durable part to its lead, who
  posts it. Questions for the lead go through `message_clankie`.
- Before retiring a seat (context near full, stale tools), put its durable state
  on the item and its machine state in the worktree handoff; the fresh seat
  starts from the item.
- Never keep work state in personal files outside the repo or in a lead-only log.

When work needs the user specifically (a decision, credentials, a physical or
live check), assign that item to their tracker account and make their part an
explicit acceptance criterion. The lead owns scope and assignment; workers
publish their own results and evidence. Shared integration, disputed acceptance
and scope changes go to their decision owner.

## Status stays true

Status says who is working now. Map these meanings onto the project's own states
and follow its workflow; leave automation-owned transitions to the automation and
do not assume a branch name changes state.

- **In Progress**: a live seat is working on it right now.
- **Verifying**: the core work is on main and a seat is finishing proof or polish.
- **Paused**: real progress, no seat right now, with one line on where it stopped.
- **Done**: landed, with an evidence comment (commit, checks, evidence link).
- **Todo**: not started.

Where Verifying or Paused does not exist, use In Progress or Todo and name the
intended status in the comment. When a seat closes, hands off or exits, Clankie
moves the issue it owned (its hire `deliverable` key) to Done, Verifying or
Paused with a one-line comment, or keeps it In Progress when another live seat
holds the same key. Built-in retirement never sets owner verification or moves
delivery backwards; report its refusal and let the lead settle the item.

In Clankie's fleet, read the effective `fleet.closure` from "Your fleet" before
closing (`clankie project settings PROJECT` shows overrides). `lead`, the
default, lets the lead close to Done after landing, passing relevant checks and
attaching evidence; workers report without waiting for owner acceptance. `owner`
parks completed work In Review for the owner to close. The owner can reopen
either. Genuine owner-only gates (App Store submission, payments, evals or
owner-account sign-ups) become linked follow-ups, recorded as unperformed,
without holding a delivered issue open. Never hide missing implementation or
verification; a setting grants no permission for the owner-only action.

## Writing

Most agent verbosity is a register error. Pick one before writing:

- **Working list** (the default): plans, review feedback, scope decisions, TODO
  capture for readers who were already there. A bare label line ending in `:`,
  then a flat list, numbered only when order matters.
- **Report**: status update, findings, verification results, for readers who
  weren't there. Bold labels, bullets, exact identifiers.
- **Discussion reply**: plain sentences. When a decision is needed, end with a
  direct question and an @-mention. A reply resolving a design point states the
  mechanism and stops: `if <goal> then <constraint> because <mechanism>`.

Cut before posting: open on the content, with no greeting, sign-off or
restatement of the ticket. Post the conclusion and its evidence, not the walk.
**Prefer editing inaccurate existing text over adding a correction comment.**
Preserve decisions, blockers, acceptance criteria, links and active dependencies
when condensing. When a decision is accepted, update the affected issue bodies
and canonical documents in the same work, keeping the historical rationale.
Backtick every identifier (`file:line` for code), use arrows for transitions
(`CREATED→DEPLOYED`), exact strings for errors and statuses, and inline links
where the fact lives.

**Result updates.** Publish when there is something meaningfully new to inspect,
a finding that changes the work, a consequential decision or a specific need for
the user. Queue changes, routine retries, acknowledgments and unchanged check
results do not earn another post. Lead with inspected media for visible work
(motion needs a clip), then use only the parts that carry new information:
**Media + what to look at**, **Result** (what the evidence establishes, delivery
stage, remaining gap), **Biggest hurdle**, **Decision**, **Need you** (only when
the user must act: the artifact, exact question, recommendation and what waits),
**Evidence link**. Label what is observed and what remains unproven; never
rewrite a failed run as a success. Keep the item's current scope, acceptance and
latest-result link readable without reconstructing the thread.

**Issue bodies.** Write for someone picking the work up cold, with no
implementation details or estimates: a one-to-two-sentence summary of what needs
to change and why; **Background** only when the why can't be re-derived (the
constraint, the failure it came from, the approach already ruled out);
**Acceptance Criteria** as verifiable checkboxes; **Context** links. Length
follows the context that can't be re-derived; past a couple of screens it is a
design doc ([design docs](reference/design-docs.md)). If you can't write one
concrete acceptance criterion, ask before drafting.

**Project status updates** curate meaningful results since the previous update
for people who were not in the threads. Read the previous update and survey
changed issues and landed work; select the results, hurdles and decisions that
change the reader's understanding. Embed media grouped by outcome, cut clips to
the interesting seconds and say what was cut, caption the actual method and scope,
and never imply the strongest claim from an unlabeled capture. Publish only media
authorized for that audience: permission to inspect third-party reference
footage is not permission to publish it. Distinguish a candidate from
a delivered build, keep important blockers, and end with what lands next and any
decision waiting on a human. A demo that shows a milestone working also goes in
the status update, so it plays in project Activity.

## Local guided reviews

For an authorized review on a built-in tracker issue, inspect first with
`clankie work review-diff BASE HEAD --repo /abs/repo` or
`clankie work review-patch /abs/change.patch`. Save the complete inspection with
`work review save --json JSON`, including `issueId`, source, exact
`expectedSource`, ordered walkthrough, anchored findings and an idempotency key.
Git identity uses returned `gitDirectory` and full commit IDs; patch identity
uses the parsed byte SHA-256, never its claimed object IDs. Save re-inspects and
refuses changed/incomplete sources. Use `review show ID --issue ITEM` and
`review list --issue ITEM --limit N --cursor CURSOR` for summaries; `show` returns
the full active inspection or a retired identity tombstone. The host denies source reads by default: use only
canonical paths in the issue project's bound local workspace repository or an
existing approved genuine linked worktree. Arbitrary host paths, symlink aliases
and remote-machine paths refuse; source paths never bypass tool/project ceilings.
Refusals include `source_authority_required`, `guided_review_source_refused` and
`source_authority_changed`. Capture runs outside the store lock, followed by
under-lock identity/binding checks and a source publication fence.

Native tools are `linear_save_guided_review`, `linear_get_guided_review`,
`linear_list_guided_reviews`, `linear_post_guided_finding` and
`linear_post_retire_guided_review`. These require an
explicit authenticated actor; external actors and other tracker backends refuse.
For edits, read first and send `findingId`, saved identity as `expectedSource`,
current review `updatedAt` as `ifUpdatedAt`, a new idempotency key, and
`edit:{action:"reply",body}` or `edit:{action:"resolve",resolved:true}`.
`resolved:false` reopens. CLI: `review edit ID --issue ITEM --json JSON`.
Existing tracker audit/receipts retain actor attribution; anchors and source
stay immutable and active reads survive source removal. Each issue is capped at
three active reviews; active immutable snapshots share an 8 MiB store budget.
Discussion and mutation receipts are excluded. Each review independently allows
256 KiB serialized discussion; `guided_review_discussion_budget` affects only
that review. Other reviews stay editable even when snapshot capacity is full.
Replies and resolve/reopen events share that same budget. Once saturated,
`guided_review_discussion_budget` can refuse resolution and reopening too,
preserving the last accepted state; no actor can edit past that limit in place.
For all three capacity refusals (`guided_review_limit`, `guided_review_budget`,
`guided_review_discussion_budget`), an authenticated owner retires an eligible
review with `clankie work owner post_retire_guided_review`, then saves a new
revision on the same issue. Retire the saturated review to recover discussion.
Use fresh keys; a previously refused key keeps its original refusal. Workers
and unproven native leads cannot reclaim; legacy full/pointer receipts may block
retirement as described below.

This unlanded contract returns compact save/edit/retire results with
`schemaVersion:1,reviewId,storeId,issueId,projectId,identity,snapshotSha256,operation,eventId,updatedAt,actor`.
Operations are `save`, `reply`, `resolve`, `retire`; event ID is string or null.
Retries and `get_write_receipt` replay the exact compact result after retirement,
never recreate payload. Full historical payload replay is no longer promised for
new writes: reread current active content with `review show`. Legacy full-result
and snapshot-pointer receipts remain readable unchanged but block retirement
with `guided_review_legacy_receipts`; do not silently migrate them.

Use `clankie work owner post_retire_guided_review --repo /repo --json JSON`
through authenticated `/v1/tracker/owner/call`, with `issueId`, `id`, saved
identity as `expectedSource`, current `updatedAt` as `ifUpdatedAt`, and a fresh
`idempotencyKey`. Retirement requires a proven owner principal. Generic
`review retire ID --issue ITEM --json JSON` refuses
`guided_review_retire_authority` without one; the normal Clankie-for-owner actor
stamp is insufficient. Current routes fail closed to owner-only retirement.
Native lead support requires a proven host capability and is not implemented
here; client actor labels, role claims and `--actor` do not grant authority.
Owner activity does not verify acceptance. Normal issue/project scope and revision/source identity
checks apply; no host source read. Explicit irreversible retirement releases
active slot and byte capacity in the same issue/store, retaining identity,
actor audit and compact receipts. Get/list return a tombstone with stable source
identity and `retiredAt`/`retiredBy`, without payload. Edits refuse
`guided_review_retired`. At `guided_review_limit` or `guided_review_budget`, an
authenticated owner can explicitly retire an eligible review before a new save. No
automatic eviction, successor issue workaround, parallel store or source rebinding.
Ordinary loads check shallow metadata; selected active full reads/writes check
snapshot integrity. Finding resolution is not owner
verification or an upstream verdict. No Work UI/device sync is provided; publish
artifact bytes through the existing evidence store. Payloads and limits:
`docs/guided-reviews.md`.
