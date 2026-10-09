---
name: linear-issues
description: "Write to Linear correctly and concisely — the API mechanics that silently destroy data (labels replace, relations append, pagination, media round-trip) and the editorial rules that size a post to the context a reader can't re-derive. Use before any Linear write: creating or updating an issue, posting a comment, editing a description or acceptance criteria. Team-agnostic; pair with your team's own skill, where there is one, for that team's labels, states, and workflow."
---

# Writing to Linear

Discover the actual Linear tool schemas before using examples below. Unprefixed
names refer to the `linear-server` MCP; Clankie's connected tools use qualified
`linear_*` names and may have different parameters. Use the workspace/account
selected by the task and verify the authenticated actor before a write.

In Clankie's confirmed fleet, load `clankie`. Admitted linked panes discover
verified connected-account tools with `clankie_tools` and invoke them with
`clankie_call`; no short manual grant/revoke cycle is needed for ordinary fleet
access. Persona-bound worker publishing still needs an exact grant or the lead.
Missing tools do not authorize a harness's independent Linear connector. A Herdr
environment variable or executable alone does not establish fleet admission.

## Linear is the source of truth

People edit issues outside this conversation. **Assume every difference between
what you remember and what's in Linear is intentional** — not a mistake to flag
or fix back.

- **Read immediately before each write** (`get_issue` before any `save_issue`),
  not once at the start of the task — and base the new text on what you just
  read, not on your own earlier draft. People hand-edit between your saves;
  writing from a stale copy clobbers their edit.
- **Their edit wins, even when it reverses something agreed.** Preserve the
  latest human edit; reverting it is the most common way an agent damages a
  shared surface.
- **If something was removed, assume it was deliberate.** Don't restore a
  dropped label, revert a changed priority, or re-add deleted text unless the
  user asks.

## Mechanics that destroy data quietly

- **`labels` replaces the entire set.** Any label you omit is removed. Read the
  current labels, then resend the full list plus your change. Relation params
  (`blocks`, `blockedBy`, `relatedTo`, `links`, `addReleases`) are append-only
  and safe to send alone.
- **Paginate everything.** `list_issues` and `list_comments` cap at 250 per page
  (default 50). Keep calling with `cursor` until it's absent. A project that
  "has 47 issues" on one page may have hundreds.
- **UUIDs vs names.** `milestoneId` and `statusUpdateId` require UUIDs — resolve
  them via `list_milestones` / `get_status_updates` first. Projects accept names,
  identifiers, or slugs; issues take IDs or `ABC-123` identifiers; documents take
  IDs or slugs.
- **Unknown labels are rejected.** Label names must match exactly; `save_issue`
  errors rather than creating them.
- **`Duplicate` needs the relation first.** `save_issue` with `state: Duplicate` and
  `duplicateOf` in one call is rejected ("Issues can only be moved to a duplicate
  state when a duplicate issue relation exists"); send `duplicateOf` alone, then
  the state.
- **`save_status_update` replaces the full body.** Read it immediately before
  the write and change only the intended segment — this is how a living deploy
  runbook gets its checkboxes ticked without losing the rest.

## Uploaded media is not round-trip safe

Read responses are not safe to send back verbatim for uploaded video nodes. A
playable video comes back from `get_*` as
`[demo.mp4](https://uploads.linear.app/...?signature=...)`; sending that text
unchanged through `save_*` downgrades it to a file card.

- Prefer patch-capable saves (`save_issue` and `save_document` take `patch`;
  `save_status_update` doesn't) so untouched media nodes stay untouched.
- Never write back the temporary `?signature=...` query a read returned. Strip
  the query string and save the stable `https://uploads.linear.app/...` asset
  URL.
- Write or recover an inline video as `![demo.mp4](<stable asset URL>)`.
  `[demo.mp4](...)` renders a file attachment instead of a player.
- If the asset must be recreated: download it while the signed URL is valid,
  run `prepare_attachment_upload` (it returns the stable `assetUrl` plus the
  signed upload request) → raw PUT with the exact returned headers →
  `create_attachment_from_upload`, then embed that `assetUrl` with `![](...)`.
- Check `prepare_attachment_upload`'s schema for a project or status-update
  target before uploading media for a status update. As of 2026-09 it takes
  only an issue: use the closest relevant issue as the hosting anchor, finalize the attachment there so the
  asset persists, then embed its stable `assetUrl` in the full status body.
  The attachment is visible on that issue, so choose the anchor deliberately.

## Write within the authorized scope

Linear holds durable product, engineering and design work, decisions and
evidence. Local fleet events — pane assignments, leadership transfers, usage
limits and queue coordination — belong in realtime agent messages or a worktree
`.local` handoff, not issue comments or descriptions (`work-items` has the
full handoff protocol).

Use the user's request, standing instructions and project workflow to determine
write authority. A mandate to lead and keep work tracked covers routine evidence,
status and current-document maintenance within that work. An instruction to post
or a writing skill such as `/linear-plan` or `/linear-grind` authorizes its defined
writes. Do not ask again for each write; the read-before-write mechanics still apply.

A request to draft, review or suggest stays a draft. Interpret dictated wording
in context: editing a draft does not itself authorize sending it, while "reply
with…" in an authorized posting task does. Ask only when an action exceeds the
mandate, such as a new external commitment or a tracker restructuring the user
reserved. Tracking authorized work does not authorize expanding its scope.

## Follow the project's status workflow

Read the project's rules and evidence for the transition. Use manual status
updates when that workflow calls for them; leave automation-owned transitions
to the configured automation. Do not assume a branch name changes Linear state.
If ownership is unclear, inspect the project's workflow before changing it.

In Clankie's fleet, read effective `fleet.closure` from "Your fleet" before
closing work; `clankie fleet status` gives global defaults and `clankie project
settings PROJECT` gives project overrides and effective values. `lead` is the
default: the lead closes to Done after landing, passing relevant checks and
attaching evidence; workers report without waiting for owner acceptance.
`owner` parks completed work In Review for the owner to close. The owner can
reopen it. Genuine owner-only gates (App Store submission, payments, evals or
owner-account sign-ups) become linked follow-ups without holding a delivered
issue open. Record them as unperformed; never hide missing implementation or
verification. A setting grants no permission for the owner-only action. Older
installs without it keep the existing workflow.

`save_release` into a completed stage can change every attached issue. Treat it
as a release action requiring authorization for that bulk effect, not a routine
single-issue update.

## Pick a register before writing

Most agent verbosity is a register error: reaching for a structured report when
the reader already has the context and wanted three bullets.

**Working list** — plans, review feedback, scope decisions, TODO capture, for
readers who were already there. A bare label line ending in `:`, blank line,
then a flat list. Numbered when order matters, bulleted when it doesn't. **This
is the default** for anything shaped like "here are the N things."

**Report** — status update, findings, verification results, design content, for
readers who weren't there. Structured: bold labels, bullets, numbered chains,
exact identifiers. Use this when someone has to reconstruct what happened.

**Discussion reply** — answering a teammate, a quick decision, an opinion. Plain
sentences, no structure — a bulleted quick reply reads as the wrong register.
When a decision is needed, end with a direct question and an @-mention.

A reply resolving a design point states the mechanism and stops:
`if <goal> then <constraint> because <mechanism>`. The mechanism is the whole
argument; an options table, trade-off survey, or recommendation section is
padding here.

## Cut before posting

- Open on the content. The reader wrote the ticket and is in the thread — a
  greeting, sign-off, or restatement of the ticket is noise to them.
- Cut stale investigation history, duplicated prose, implementation diary, and
  "then I checked… then I found…" narration. Post the conclusion and the
  evidence for it, not the walk.
- **Prefer editing inaccurate existing text over adding a new comment.** A
  correction thread where an edit would do is how issues become unreadable.
- Preserve decisions, blockers, acceptance criteria, links, and active
  dependencies when condensing. Those are the parts that can't be re-derived.
- **Close accepted decisions in the current docs.** Update affected issue bodies
  and canonical project/repo documents in the same work, so a later comment does
  not leave the plan prescribing a rejected option. Preserve the historical
  decision record and its rationale; current instructions describe the accepted
  choice. If newer edits conflict, resolve that conflict before replacing them.

## Result updates

Publish when there is something meaningfully new to inspect, a finding that
changes the work, a consequential decision, or a specific need for the user.
Keep detailed attempts and logs in the existing evidence archive; preserving a
run does not require publishing a comment about it. Queue changes, routine
retries, acknowledgments and unchanged check results do not earn another post.

Lead with inspected media for visible work: gameplay, a turntable, a deformation
comparison, or source-to-retargeted motion. Motion needs a clip; a static change
can use stills. Use the existing capture path and retain the original. Supporting
reports carry technical detail and provenance. For headless work, show the
decisive observable result without manufacturing an unrelated image.

Use only the parts that carry new information, in this order:

- **Media + what to look at:** caption the subject and useful timestamps.
- **Result:** what the evidence establishes, its delivery stage and remaining gap.
- **Biggest hurdle:** the main difficulty and how it was resolved or still blocks work.
- **Decision:** the accepted choice and why; link deeper rationale where needed.
- **Need you:** only when the user must act; include the artifact, exact question,
  recommendation and what waits on the answer. Do not turn routine updates into
  approval requests.
- **Evidence link:** the retained report and tested revision, without a log dump.

Evidence folders follow the repository's store rule: write the folder README,
run `clankie evidence push <folder> --issue <KEY>` (or `evidence_push`), and
commit only `README.md` and `evidence.json`. Cite the printed
`clankie://evidence/sha256/...` links in the comment. Linear screenshots may be
uploaded for display, but the evidence-store copy is the record.

Publish useful candidates and meaningful failures before final integration;
label what is observed and what remains unproven. Reuse an existing attachment
and update its caption or current-result pointer when appropriate. A new comment
earns its place through a material result or decision, not a change of reporter.
Keep the issue's current scope, acceptance criteria and latest-result link
readable without reconstructing the thread. Preserve historical evidence and
decision rationale; never rewrite a failed run as a success.

## Notation

- Backticks on every identifier — routes, tables, files, statuses, constants —
  with `file:line` when pointing at code.
- Arrows for transitions and cause→effect: `CREATED→DEPLOYED`,
  `empty campaign submit → 400`.
- Exact strings for errors and statuses, never paraphrased. `~` for
  approximations. Real timestamps in timelines.
- Inline ticket/MR links where the fact lives, not collected at the bottom.

## Issue bodies

Write for someone picking the work up cold. No implementation details (file
paths, function names, code) and no time or point estimates.

```markdown
<summary of what needs to change and why — 1-2 sentences when that's enough>

## Background (when the why can't be re-derived)

<the constraint, the failure this came from, the decision it implements, the
approach already ruled out — what a reader would otherwise reconstruct from a
thread>

## Acceptance Criteria

- [ ] <verifiable check>

## Context (if applicable)

<links, screenshots, references that help someone start cold>
```

**Length follows the context that can't be re-derived, not a word budget.** One
line is right for self-evident work; a ticket carrying a decision, a constraint,
a prior failed approach, or negative space ("not X, because Y") earns the
paragraphs that say so — that's the part nobody can reconstruct later. What
stays cut at any length is the padding _Cut before posting_ names: narration,
restatement, options surveys. Past a couple of screens the material is a design
doc — write it there and keep the issue pointing at it.

If you can't write at least one concrete acceptance criterion, ask before
drafting.

## Project status updates

A project update curates meaningful results across the project since the
previous update for people who were not in the threads. Use the result-update
format above, grouping media by outcome or system.

- Read the previous update and survey changed issues and relevant landed work
  across the project. Select the results, major hurdles and decisions that
  change the reader's understanding; no paragraph is owed to every lane or commit.
- Embed useful media and link its issue evidence. Preserve important blockers
  even when they have no new media; distinguish a candidate from a delivered
  build. Technical detail remains on the issue or retained report.
- Show intermediate stages when they explain quality, a transformation or a
  failure. Compare the same subject with consistent framing where useful;
  do not render every intermediate record just to illustrate a pipeline.
- Cut to the interesting seconds. A 170-second take becomes 50; drop the
  run-ups, the dead air and the part where nothing moves. Say what was cut.
- Caption the actual method and scope: offline render, sampled frames, editor
  playback, or one machine over loopback. Keep edits that affect interpretation
  visible; never imply the strongest possible claim from an unlabeled capture.
- Clearly labeled failures and before/after comparisons belong when they explain
  a hurdle or a decision. Publish only media authorized for that audience;
  permission to inspect third-party reference footage is not permission to publish it.
- Link issues and consequential decisions. Include an ADR or revision when it
  helps establish the claim, rather than adding one identifier per line.
- End with what lands next and any decision waiting on a human.

## Design docs

Bigger than an issue body: a living doc attached to the project, revised in
place as decisions land.

- **TL;DR first** — one paragraph enumerating the concrete deliverables
  ("three new Postgres tables, three small keyword endpoints, one runtime hook,
  new UI for adding keywords at flow creation"), ending with what it unlocks
  later.
- **Sections by system layer** (DB / API / Runtime / UI), each header carrying
  its ticket(s): `## Runtime ([ABC-1399](url) · [ABC-1400](url))`.
- **Bullets, not prose — each bullet is `decision — why`**, with the rejected
  alternative in parens. Nest per column or field under a table's bullet, and
  use bold-labeled sub-lists (**Rollout:**, **Ceiling:**) for justifications
  that forecast a future scenario.
- **State the negative-space decisions**, with reasons — "No per-keyword
  PUT/PATCH — keywords have no mutable attributes", "No `account_id` — the
  authorizer middleware owns account scoping". What you decided _not_ to build
  is the part nobody can re-derive from the schema.
- **Name the flags it depends on.** Which existing flags gate what this now
  needs — the one that gets missed, because it's about code you aren't writing
  and no diff-scoped review sees it ("linking to a specific message is retired"
  is what made links require the newer `flows-enabled` flag).
- **Numbered lists for migrations and cutover sequences**; pseudocode with
  inline comments for runtime flows; sequence diagrams as images, in Before /
  After pairs where the After caption states only the delta ("**After** — step 2
  disappears; the step-1 hit already carries the config").
- **Sequence of Work** — a `→` chain of linked tickets, each with a 2-4 word
  label, plus out-of-band ordering notes on their own lines ("ABC-1400 can land
  any time after ABC-1398").
- **End with Open questions**, each with an owner and a leaning, not a bare
  question. A question nobody is holding doesn't get answered.
- **Revise in place when a question resolves** — rewrite the body to the new
  decision rather than appending, and turn the open-question entry into a
  verdict plus what is still deferred. Re-read the doc immediately before each
  edit; these get hand-edited between passes.
