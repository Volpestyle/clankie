# ADR 0346: The fleet says who is leading

Status: Proposed, 2026-11-02, from James's ask for a hoodie per active lead in the app's World. Builds on 0304 and 0321.

Amended by [ADR 0350](0350-the-owner-switches-clankie-on-and-off-from-his-app.md): Clankie is active exactly while the lead setting is `clankie`; a turn he takes while the apps lead updates `lastActiveAt` but never marks him active.

## Context

Several leads drive the same fleet: Clankie's own captain, and connected apps such as Claude Duet and Grok through the connector. The roster says who started each agent (0321), but nothing says which leads are around right now. The app's World wants to draw each active lead, and only active ones: Clankie's figure only while his own agent is actually leading.

## Decision

- A leads read. GET /v1/fleet/leads (owner app read, through the relay like the roster) answers { schemaVersion: 1, observedAt, leads }. Each lead is { id, kind: "clankie" | "app", name, active, lastActiveAt? }. No lead outranks another; sorted by id.
- Clankie is one lead, id clankie. Active while the lead setting is clankie (0304) and his service is up, or while his captain ran a model turn in the last ten minutes. His last activity comes from the current process's turn observation and existing durable settled-turn metrics.
- Each connected app is one lead per active connector device: id is the device id, name the name it registered with, lastActiveAt its last seen time; active when seen in the last fifteen minutes. Revoked or expired devices are not listed. Device registration has no session expiry field: expired automation runs are excluded, while an expired bearer alone does not revoke a refreshable registration.
- Hires join their lead by name: an app's hires carry startedBy { kind: "app", name }, and the app matches that name. Two apps under one name read as one lead.

## Consequences

- The default read states facts the host already keeps and grants nothing. The channel opt-in below adds display attribution to existing hire records.
- A quiet app becomes inactive within fifteen minutes; a webhook-woken one shows while it works. Inactive registrations remain in the read with active false.
- Connector traffic already records device.seen at most once a minute through the relay's /v1/devices/self check for the default read; channel activity below is observed in memory.
- The connector's list_agents is unchanged.

## Channels

- Connected leads pass their owner-known chat or channel name as optional `channel` on worker tools. It is trimmed, 1–64 characters, grants nothing, and is never sent to the worker. Hires persist it with the starting device.
- `?includeChannels=true` groups leads by device and channel, with stable `${deviceId}:${channel}` ids, `appId`, exact live `hires`, and optional `channel`. A channel is listed while seen in the last 24 hours or holding a live hire; activity expires after 15 minutes. Unnamed traffic has a device lead. The default v1 response stays unchanged.
- Each expanded lead has `touches`: up to 20 confirmed worker acts from the last 30 minutes, newest first (`hire`, `message`, `answer`, `close`), with exact seat and occupant ids and time. Activity and touches are in memory; hire attribution survives restart. Clankie's own recorded worker visits supply his touches.

## Evidence and limits

This record retains the proposed 24-hour channel listing and 15-minute activity expiry. These are version-specific observations or bounded implementation choices, not a new measurement of optimal defaults. This documentation update does not rerun their original proof or change their status.

## Revisit when

Revisit when observed lead activity or app rendering shows stale or disappearing leaders; evaluate those cases before accepting or tuning the proposal, keeping channel/name metadata non-authoritative.
