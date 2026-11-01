# ADR 0321: The roster says who started each agent

Status: Accepted, 2026-11-01, as step 5 of the Clankie cut and reshape that
James approved ("one shared view of sessions and who owns what"), with his
word that no lead outranks another ("i dont think any assistant gets
precedence they all have their ways to recieve notifications").

## Context

The roster's `ownership` says whether a pane is a host-recorded hire, a
hand-started pane a conversation adopted, or unowned. It cannot say who asked
for a hire. A hire a connected app made through `start_agent` looked the same
as one Clankie chose himself, because the app's device was dropped once the
hire's conversation owner was captured. The owner's own app showed only
"Spawned by" for agents another agent started, and nothing for the rest.

## Decision

- **A hire records who asked for it.** The hire intent carries an optional
  `startedBy`: `{kind: "app", deviceId}` when a connected app's `start_agent`
  asked, `{kind: "owner"}` when the owner's own app asked, and nothing when
  Clankie chose the hire himself. Binding the native occupant copies it from
  the intent; re-binding and exact reattachment keep it. Older records have
  none and read as Clankie's.
- **The roster says it on request.** `GET /v1/fleet/roster?includeWork=true&includeStarters=true`
  (`FLEET_ROSTER_STARTERS_PATH`) adds `startedBy` to each agent:
  `owner` (asked from the owner's app, or a pane started by hand that was
  never hired), `clankie`, `app` with the device's own name, or `agent` with
  the name of the agent whose pane started it. The starter belongs to the
  exact occupant, so a replacement in the same seat does not inherit it.
  The work read and the unnegotiated read keep their shapes for shipped apps.
  The relay and the sealed gateway client admit the new path as an exact
  GET, like the work path. The CLI and the shared API client request it.
- **Display only.** `startedBy` grants nothing and ranks nothing. Who may
  message, retire or answer an agent stays where it was: the hire's owning
  conversation and the owner's permissions. No starter takes precedence over
  another.

## Consequences

- The app can show "Started by you", "Started by Clankie", "Started by <app>"
  or "Started by <agent>" on Sessions and the team view (the next slice).
- A hire made before this change reads as Clankie's, even if an app asked.
- A connected app sees its own device name on the agents it started, so an
  owner with several leads can tell their hires apart.
