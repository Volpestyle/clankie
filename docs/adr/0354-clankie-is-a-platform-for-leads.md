# ADR 0354: Clankie is a platform for leads

Status: Accepted, 2026-11-03, on James's positioning brief relayed by his lead:
Clankie is "no longer a lead agent" but an open-source, self-hosted "super agent"
platform. Amends the identity in
[ADR 0156](0156-the-docs-site-renders-the-canonical-references.md); its rendered
references stand. Builds on
[ADR 0181](0181-clankie-is-independent-of-his-connections.md).

## Context

The public docs presented Clankie as one agent with a personality who leads a
team. The decisions since have moved past that. The hosted body went
([ADR 0300](0300-clankie-runs-only-on-the-owners-machine.md)). Outside apps gained
a connector ([ADR 0301](0301-claude-reaches-the-fleet-through-a-narrow-connector.md)),
then could take the lead ([ADR 0304](0304-the-owner-hands-the-lead-to-connected-apps.md)),
be woken at a webhook ([ADR 0336](0336-a-connected-app-wakes-a-lead-at-its-webhook.md))
and close their own hires ([ADR 0339](0339-connected-apps-close-finished-hires.md)).
The fleet now lists several leads, none outranking another
([ADR 0346](0346-the-fleet-says-who-is-leading.md)), and the owner can switch the
built-in one off ([ADR 0350](0350-the-owner-switches-clankie-on-and-off-from-his-app.md)).

## Decision

The public story leads with the platform. Clankie makes it easy to run always-on
leads on your own machines and to tie in the leads and workers you already have.
Leads hire coding workers across those machines, and Clankie shows the work.
Leads you talk to directly are what separate it from ticket-board tools.

- **The persona is the built-in lead.** It keeps its name, character and "he" on
  the pages about it, and [its own guide](../built-in-lead.md) holds the material
  the README used to lead with.
- **Internal names stay.** `captain` identifiers, routes and event types, and the
  runtime persona instructions, do not change.
- **Say what ships.** Copy names no view that doesn't exist. The activity view is
  the app's Feed; nothing ships yet as an artifact library.

## Consequences

- `README.md`, the docs site and the architecture overview use this framing, and
  `maintain-docs` holds the voice rule. `retired-claims.json` rejects the old
  "agent lead" tagline in live guides.
- The landing page, its film and the app's README are outside this repository and
  still need their own change.
