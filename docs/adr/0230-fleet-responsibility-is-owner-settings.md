# ADR 0230: Fleet responsibility is owner settings

Status: VUH-1649 approved; working-preference extension proposed for review
(2026-10-05; VUH-1663).

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
closure. Genuine owner-only gates, including payments, evals and sign-ups on
owner accounts, become linked follow-ups without holding
otherwise delivered work open. Missing implementation or required verification
remains visible and cannot be declared passed.

The settings never authorize sign-ins, codes, CAPTCHAs, payments, account
changes, credentials or destructive actions outside fleet workspaces. Setup
never restarts or steers existing lanes. A policy value does not mint an
operator credential, machine link, workspace grant or consent to arbitrary
third-party setup. Source-managed Codex setup retains its script/path and
configuration fences. Automatic lead setup may use the native plugin manager or
an exact, previously remembered source setup. A new source setup script always
needs interactive owner consent. `--approve` requests that confirmation; it
cannot supply approval in a headless process. The server cannot observe the
human confirmation and records `ownerApproved` only as a caller claim, never
verified owner presence or additional authentication authority.

## Shape and resolution

Persist global defaults in the shared owner policy block:

```json
{
  "autonomy": {
    "fleet": {
      "closure": "lead",
      "machineSetup": "lead",
      "commit": "lead",
      "push": "lead",
      "release": { "mode": "owner" },
      "verification": "change_run_read",
      "reportingStyle": "Short and plain."
    }
  }
}
```

A project may persist any leaf under `project.autonomy.fleet`; absence
inherits the global value independently. Clearing an override removes only
that leaf. Existing settings materialize both global defaults on read; project
reads preserve missing overrides. Release is one atomic leaf: its mode and rule
are replaced together. A project null patch removes an override; a global null
patch restores that leaf's default. API updates fence the current revision and
owner authority, including authority changes while a request waits.

The settings schema is strict. A current binary materializes the `autonomy`
defaults on read; its next settings save persists that block, including when
it changes another setting. An older binary that predates the field cannot
load that file. Upgrade all readers before saving settings; a binary rollback
also requires an owner-reviewed compatible settings backup. This is an accepted
compatibility limit, separate from the legacy API projection described below.

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
Remote CLI approval retains the exact registered target revision across the
terminal confirmation and dispatch; changing an alias's SSH target or session
requires a fresh confirmation. API callers may assert that target revision;
without it their consent claim names the current alias rather than proving a
previously observed target.
Settings changes take effect without restarting or steering an existing lane.
Pi catches extension exceptions and continues, so a failed fresh policy read
replaces stale delegated guidance with an unavailable policy block for that turn.
Native prompt reads reject the same ambiguous or unverified project context.

## Working preferences (VUH-1663)

The same `autonomy.fleet` block also carries how agents work:

| Leaf             | Choices                                                          | Global default     |
| ---------------- | ---------------------------------------------------------------- | ------------------ |
| `commit`         | `lead` (without asking), `owner` (ask first)                     | `lead`             |
| `push`           | `lead` (without asking), `owner` (ask first)                     | `lead`             |
| `release`        | `{mode:"lead"}`, `{mode:"owner"}`, `{mode:"time_rule",rule:"…"}` | `{mode:"owner"}`   |
| `verification`   | `review_and_seal`, `change_run_read`                             | `change_run_read`  |
| `reportingStyle` | Owner-authored text                                              | `Short and plain.` |

Release covers official tags, packages and store submissions. A time rule is
owner-authored guidance for an agent to check against current evidence; it adds
no scheduler or expression evaluator. Independent review and sealing means a
separate reviewer checks the completed change, findings are addressed, and the
reviewed revision is sealed with verification evidence. Change/run/read means
making the change, running focused relevant checks and reading their results.
Explicit task and integrator gates take precedence. These preferences grant no
additional account, tool, shell or workspace authority, and do not authorize
evals, payments, sign-ins or account creation.

On a legacy settings read, default commit/push without asking and ask before
official releases. If an existing owner project has ID `clankie` and no release
override, seed its weekly rule: release without asking when the last `v*` tag is
more than one week old and `main` has user-visible changes worth shipping. Never
create a project, workspace or grant as part of migration. If Clankie has no
registered project, the global ask-first release policy applies until the owner
registers the project and chooses an override. Existing explicit overrides win.
Any persisted new global preference marks this migration as done; the next
settings save records the materialized preferences. Clearing the seeded project
override after that save remains cleared on future reads.

Clankie can read/change these preferences through the existing fleet/project
tools and CLI. The app and TUI use the same settings, and every actual hire brief
includes the resolved preferences for its verified project, including a
preferences-only native brief for a hire without a task brief. The "Your fleet"
prompt refreshes the resolved policy each turn. Agents launched independently
can read the verified workspace context with the CLI and `doctor`. Unavailable
context is reported rather than guessed.

Transport responses advertise `workingPreferences:true`. New response leaves
are optional without parsing defaults, so old servers never appear to support
new controls. An app talking to an older server keeps the existing closure and
machine-setup controls and hides the five new controls. Legacy project responses
still omit autonomy and the marker unless the client opts in. Disk defaults and
the existing strict-binary rollback limitation remain separate from transport
compatibility.

## Alignment and next candidates

[VUH-1523](https://linear.app/vuhlp/issue/VUH-1523) proposes an always-on mode,
a Pi `self` principal, per-capability `off|ask|on` envelopes, budgets and pause.
That proposal remains unaccepted and is not implemented here. The shared
`autonomy` block can grow alongside `fleet` when those decisions are accepted;
these responsibility choices do not imply background execution or an always-on
mode. The existing `captain/autonomy.ts` and `AutonomyStore` manage goals and
self-wakes, not owner policy; this work adds no `/autonomy` command.

Possible later responsibilities include landing, deployment and outward
posts. Their defaults, scopes and approval envelopes need their own decisions;
none is delegated by these settings.

## Consequences

The default removes owner-acceptance waits from completed fleet work and permits
routine preparation of already-linked machines. Owners can independently take
back each responsibility globally or per project. Older app/server pairings
omit unadvertised autonomy controls; legacy project responses retain their prior
shape unless the client explicitly requests autonomy fields. This change
preserves existing authentication, workspace and account boundaries.
