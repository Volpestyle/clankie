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
- **Connected apps see it too.** A `fleet` read with `includeStarters: true`
  adds the same `startedBy` to each seat; without it the seat has none, so
  older strict readers are unchanged. The connector's `list_agents` asks for
  it and says who started each agent in words ("the owner", "Clankie", an
  app's device name, or an agent's name), and falls back to a plain fleet read
  on a Clankie from before it. The app layer gives the captain the paired
  devices' names, so every read names an app the same way.
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

## Amendment: the hiring app reaches its agent as its lead (#442, 2026-11-03)

"Display only" left a connected app's own hires without a lead. A hire an app
made through `start_agent` is owned by Clankie's thread, so when the app
messaged that agent (the connector's `message_agent`, a send to the agent's
persona thread) the worker saw a plain message, not `sender="lead"`, and its
brief told it not to act on unmarked "lead" messages.

- **One narrow exception.** A connector send reaches the agent as its lead
  when the device the relay stamped on it (`appDeviceId`, from the connector
  credential it authenticated) is the `startedBy.deviceId` of the exact
  occupant now in the seat, and nobody has adopted that occupant since. The
  check runs at delivery against the live occupant, and the delivery stays
  bound to it.
- **Device-level, not app- or chat-level.** The mark is granted per connector
  device. Every session behind that one device credential, such as two chats
  in the same connected app, reaches the agent as its lead. A different device,
  even one registered under the same name or naming the same `channel`, does
  not. The caller's `channel` and the message text never count.
- **Not inherited.** The hire records the occupant the app's intent bound
  (`appLeadOccupantId`). A replacement in the same seat, including a journaled
  restart successor that keeps `startedBy` for display, is not that occupant.
- **Adoption ends it for good.** When Clankie's thread or any other
  conversation adopts the occupant (by messaging it with `message_seat`), the
  hire stops recording the app's lead, and the device's later sends are plain
  messages again, across restarts.
- Everything else here stands. `startedBy` still ranks nothing on the roster,
  and owning, retiring and answering an agent stay with its owning
  conversation and the owner's permissions. The mark gives the hiring app's
  messages only a lead's authority within the worker's brief, as for any lead.
