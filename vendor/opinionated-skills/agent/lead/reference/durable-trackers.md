# Durable trackers

Use the existing tracker and workflow. Local records suit a bounded delivery whose
owners share a checkout; an external tracker helps when work spans sessions,
projects or people who need to find decisions without reading agent transcripts.
Recommend adoption for that concrete need, not because an integration exists.
Tracking supports delivery; setting up a tracker must not preempt a ready result.

## One record per owned outcome

Track a result someone can accept, not an agent, turn or tool call. Split work when
it has independent acceptance, ownership or a dependency that needs separate
resolution. Use a checklist for steps within one result. A lane can produce
several deliverables over time; its name is not a permanent ticket identity.

A reader picking up the record cold should find:

- The intended result, why it matters and observable acceptance.
- The accountable owner and who decides scope or disputed acceptance.
- Actual prerequisites, with the blocking result and who can resolve it.
- The current delivery stage, inspected evidence and its relevant limitations.
- Remaining gaps and the next action with its owner.

Use native fields and relations where available; do not repeat them in prose.
Keep checkout paths, file claims, pane routes and resource leases in the live
brief or existing ownership tooling. Link technical specifications and decisions
where the repository keeps them instead of copying entire documents into issues.

## Completion means the agreed result

Use the project's existing statuses and transition authority. These distinctions
must stay visible, but do not require four new workflow states:

| Fact | Evidence needed |
| --- | --- |
| Worker reports complete | Produced result and checks against the agreed acceptance |
| Accepted | Required review or acceptance decision, with any explicit waiver |
| Landed | Result is at its agreed integration destination |
| Delivered | Agreed consumer or integrated behavior works at the requested destination |

An offline component can be accepted without proving the full product. Where
several accepted components must work together, give integration its own owner
and acceptance in the existing parent or a focused deliverable. Component closure
must not imply integrated delivery.

If a worker omits promised behavior, keep the unmet acceptance visible. The scope
owner decides whether to finish it, remove it with rationale, or defer it into an
owned, linked follow-up. Close an accepted slice only under that decision; never
mark missing verification as passed. Blockers name the missing prerequisite and
next action, not merely "waiting."

## Local records

Use the repository's existing layout. Keep the shared plan lead-owned and link
each deliverable's owner-written record; a small plan needs no extra file until
independent writers or substantial content justify one. Keep acceptance and
status in one place. Read current contents before editing, preserve others'
changes, and make scoped edits rather than replacing files from old copies.

Keep durable records under version control and land them with the relevant work
under repository policy. A scratchpad is a continuation aid, not the sole home
of an accepted result. Link retained evidence from the record; do not duplicate
archives or commit large media merely to make it discoverable.

## Mapping to Linear

Use the direct workspace Linear MCP and load `linear-issues` before writing;
it owns read-before-write, media publication and result-update mechanics.
Inspect the existing project, issues and workflow before creating anything.

| Work concept | Linear representation |
| --- | --- |
| Bounded outcome spanning several deliverables | Project; smaller work can remain one issue with sub-issues |
| Independently accepted deliverable | Issue with acceptance and an accountable owner |
| Separately owned part of that deliverable | Sub-issue when it warrants independent tracking |
| Required predecessor | Blocking relation; related work alone is not a blocker |
| Meaningful project checkpoint | Milestone when useful; never one per pane or worker |
| Integrated delivery | Existing parent acceptance or an explicitly owned integration issue |
| Accepted result or actionable failure | Evidence on its issue, with current stage and remaining gap |
| Architecture or interface decision | Link to the canonical repo/project document |

Keep current scope, acceptance and the latest-result link readable in the issue
without reconstructing its comment history. Workers publish evidence once;
the designated transition owner updates status under the project workflow.
Publish only meaningful results, consequential decisions or actionable blockers.
Do not create a tracker agent merely to relay these updates.

## Moving an existing plan

Within an authorized migration, reuse matching issues first. Map outstanding
deliverables and prerequisites, retain accepted evidence and explicit gaps, and
name the integration owner. Historical completed steps need separate issues only
when they carry a dependency, acceptance record or evidence the project needs.

Put stable issue links in the local index and make Linear canonical for status
and acceptance. Remove duplicate local status fields while retaining relevant
technical docs and original evidence. Carry acceptance forward unchanged; moving
records does not reopen accepted work or create another review gate. An unavailable
tracker permits a pending update in the existing continuation, not a competing
tracker or a claim that the remote write succeeded.
