# Diagnosing a missing route

Detail for [Working beside Clankie](../SKILL.md). Use these bounded reads to
explain a gap before reporting it to your lead.

## Admission

Local Linux workers require kernel-backed admission on a host in its initial PID
namespace, with genuine, fully visible procfs. Containers are unsupported;
`unsupported_pid_namespace` in `clankie metrics --fleet` means this host boundary
refused the request. Do not substitute a bearer, caller PID, another account or
weaker process scan. The hosted containment-receipt route is not yet available.
Details: `integrations/fleet-proof/README.md`.

Fleet admission grants every tool from verified connected accounts while
`fleet.tools` is `connected`; no project, native session or workspace proof is
needed for tools. Bearer links prove only the fleet, not a pane or mailbox.
Linear worker-publishing tools requiring an exact `personaId` remain excluded.
Project roles, caps, hiring and tracker binding are separate. Tool access is not
permission for every write. If tools are absent, report the machine/session,
catalog and refusal so the lead can inspect admission, the setting and account.

## Linear connectors

Never substitute a harness's independent Linear connector. Claude worker and operator plugins deny
inherited Linear MCP tools locally, including in hand-started sessions without
a bridge. Their startup notice explains posting through Clankie's tools; plain
Claude without either plugin keeps the owner's connector. Use `clankie claude`
for the operator seat, or load the worker plugin for a fleet session. Do not edit
the owner's profile to enforce this. An explicit signed user actor is necessary
for owner wakes, but user-authenticated external connector output may be
indistinguishable from human comments; do not claim actor identity proves origin.
Codex launches discover and disable Linear-named app connectors as well as inherited
Linear MCP servers for that session. Existing running seats may still expose
`codex_apps.linear`; always use `clankie_tools` and `clankie_call` for Linear.

## Bounded reads

On a host with the owner-authorized CLI, these bounded reads explain a gap:

- `clankie doctor --json`: distinguish installed, enabled, version, bridge, hooks,
  skill presence and live membership. `liveReceiver: not-observed` is not a
  working reply channel. `doctor --machine NAME --json` inspects one remote machine.
- `clankie doctor` also exposes session-bound `toolCatalogHealth`: `matched`
  proves the native harness listed its bridge's expected tools, `mismatch` names
  missing tools, and `unverified` keeps absent native evidence explicit. Follow
  that row's fixing action when actionable. Embedded hand-started Codex cannot
  expose its native catalog; this is advisory. Continue with your current lead
  and the tools the pane exposes. Report a specific missing-tool blocker to
  that lead; catalog verification does not require a new hire. Do not switch to
  the shared daemon to fix this: inherited pane identity can break worker bridges. Roster `toolCatalog` carries the same verdict.
- `clankie connections`: identify the intended machine/session and connected
  account. A healthy SSH link is transport health, not a native tool-call result.
- `clankie fleet roster`: read live counts plus `project`, `task` and `ownership`.
  Project uses exact-occupant confirmed membership; unknown is `null`. Task uses
  an explicit assigned issue/deliverable, with `title: null` when no cached title
  is available. Never fill either from pane captions. `ownership` distinguishes
  `hired`, adopted hand-started `owner` panes, and `unowned` panes; unadopted
  personal panes remain unowned. Counts still include every row. New device
  clients request `GET /v1/fleet/roster?includeWork=true`; the unnegotiated strict
  v1 response stays unchanged for shipped apps.
- `clankie fleet status`: inspect `fleet.tools` (`connected` or `off`) and
  `fleet.peerMessages` (`on` or `off`).
- `clankie access linear` and `access list`: inspect the connected actor and
  manual/legacy grants. Never paste grant files, bearers or broker data.

These CLI reads require the installed service's access; a worker plugin does not
confer operator CLI authority. If unavailable, report the exact native catalog
and error, and ask the lead to inspect. Do not copy owner credentials or invent
environment bindings. On a PC, localhost is that PC: use its configured fleet
link instead of assuming the Mac service lives there.

## Catalogs and schemas

Project roles and caps govern hires independently of fleet connected tools.
Native Codex subagents expose optional stable IDs and `startedAt`/`endedAt`
in the roster; older hosts can omit them. They remain children of their parent
session; a child result
or roster status alone does not prove the parent's deliverable is complete.
For an unavailable native route, report the exact refusal and observed catalog.
A healthy remote link or successful host probe is not native tool acceptance.
Connected tools with incompatible client schemas are omitted individually;
`mcp.host.tool_rejected` logs the provider, tool and rejected field. An absent
tool can be a schema rejection even when the rest of that server is healthy.
For repository changes, `pnpm mcp:check` checks every lane and the fleet bridge
against the strict native client contracts and identifies the offending tool.

## Fixture admission

The source-only `fixture-admission` candidate is a separate, single-use private
get_user route, not general fleet membership or positive original proof. Its
original-facing route requires admittedProjectProof; its separate callback
requires the host-minted fixture capability and actual fixture lifetime.
Fixture `read`/`read-status` require the private `--fixture` descriptor and never
discover installed links/defaults. Native login account stays unverified under
host-seat/v1. Follow `docs/native-fixture-admission.md` and the current owner
scope; an available command never clears held original or UNKNOWN work.

## Operator seat upgrade migration (VUH-2888)

The preparation release observes binding refusals without refusing admission.
`clankie doctor --json` reports `operatorSeatBindings.mode` and a fresh local
launcher `inventory`; unbound, incomplete or held migrations block an enforcing
update. Observe mode preserves the old stray-process gap.

For an old Claude launcher use `clankie seat migrate prepare --conversation ID`
from another shell. Preserve its printed migration ID. Doctor names the original
session/profile/cwd and exact `clankie claude --resume SESSION --conversation ID
--migration UUID` recovery. Reconcile original receipt IDs; never replay calls.
Exit only the named old native session. The resume claim requires proven old
exit and is one-shot: an interrupted claimed launch stays held, never retried.
Trust/hook prompts need the owner's ordinary action. `clankie seat migrate
status UUID` is read-only; `complete UUID` releases only after the same native
session/profile/cwd has a live binding and readiness. Missing proof holds.
For a definitive failure before spawn, prove that no successor exists, then
start the same exact resume without `--migration` and complete the original ID
once ready. Never repeat its claim. An uncertain spawn stays held.
