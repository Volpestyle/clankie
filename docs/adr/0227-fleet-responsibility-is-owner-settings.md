# ADR 0227: Fleet responsibility is owner settings

Status: proposed for review (2026-10-05; VUH-1649).

Extends [project owner settings](0216-projects-own-agent-roles-and-tool-policy.md)
and [fleet access](0217-fleet-membership-gets-connected-tools.md).

## Decision

The owner chooses who closes delivered work and who prepares Clankie's own
harness setup. Both settings default to `lead`:

| Setting              | `lead`                                                                                                                                                                | `owner`                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `fleet.closure`      | The lead closes to Done after landing, passing relevant checks and attaching evidence; the owner may reopen.                                                          | Park delivered work In Review for the owner to close. |
| `fleet.machineSetup` | Leads/workers may install, refresh and prepare Clankie's own harness plugins, bridges and worker setup on already-linked machines through existing authorized access. | Ask the owner before those setup changes.             |

Workers report to their lead without parking for owner acceptance under lead
closure. Genuine owner-only gates, including App Store submission, payments,
evals and sign-ups on owner accounts, become linked follow-ups without holding
otherwise delivered work open. Missing implementation or required verification
remains visible and cannot be declared passed.

The settings never authorize sign-ins, codes, CAPTCHAs, payments, account
changes, credentials or destructive actions outside fleet workspaces. Setup
never restarts or steers existing lanes. A policy value does not mint an
operator credential, machine link, workspace grant or consent to arbitrary
third-party setup. Source-managed Codex setup retains its script/path and
configuration fences.

## Shape and resolution

Persist global defaults in the shared owner policy block:

```json
{ "autonomy": { "fleet": { "closure": "lead", "machineSetup": "lead" } } }
```

A project may persist either leaf under `project.autonomy.fleet`; absence
inherits the global value independently. Clearing an override removes only
that leaf. Existing settings materialize both global defaults on read; project
reads preserve missing overrides. API updates fence the current revision and
owner authority, including authority changes while a request waits.

The CLI's `fleet` projection, TUI fleet editor and app fleet settings show these
choices beside size/models. Project settings show overrides and effective
values. Machine-bearing "Your fleet" prompts resolve current project context,
and service sessions refresh that context on each turn. Social lanes retain
their existing authority. The lead, Linear workflow and issue-writing skills
read the effective closure policy rather than assuming owner review.

Machine setup resolves a verified source workspace separately from the current
linked target. A Mac lead can prepare a linked PC or KH2 through existing
operator access; a native remote worker's fleet proof alone does not become
operator CLI authority. Invalid or ambiguous workspace evidence fails closed.
Settings changes take effect without restarting or steering an existing lane.
Pi catches extension exceptions and continues, so a failed fresh policy read
replaces stale delegated guidance with an unavailable policy block for that turn.
Native prompt reads reject the same ambiguous or unverified project context.

## Alignment and next candidates

[VUH-1523](https://linear.app/vuhlp/issue/VUH-1523) proposes an always-on mode,
a Pi `self` principal, per-capability `off|ask|on` envelopes, budgets and pause.
That proposal remains unaccepted and is not implemented here. The shared
`autonomy` block can grow alongside `fleet` when those decisions are accepted;
these responsibility choices do not imply background execution or an always-on
mode. The existing `captain/autonomy.ts` and `AutonomyStore` manage goals and
self-wakes, not owner policy; this work adds no `/autonomy` command.

Possible later responsibilities include landing/push, deployment and outward
posts. Their defaults, scopes and approval envelopes need their own decisions;
none is delegated by these two settings.

## Consequences

The default removes owner-acceptance waits from completed fleet work and permits
routine preparation of already-linked machines. Owners can independently take
back either responsibility globally or per project. Older app/server pairings
omit unadvertised autonomy controls; legacy project responses retain their prior
shape unless the client explicitly requests autonomy fields. This change
preserves existing authentication, workspace and account boundaries.
