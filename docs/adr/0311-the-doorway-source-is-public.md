# ADR 0311: The doorway's source is public

Status: accepted (James, 2026-10-31: "Yes, publish it"). Amends
[ADR 0183](0183-the-harness-is-public-the-hosted-service-is-private.md): the
gateway source moves back into this repository. Its deployment, accounts and
records stay private.

## Context

ADR 0183 kept the gateway behind `api.clankie.bot` private because it ran only
on Clankie's servers and sat beside the paid hosted service. ADR 0300 retired
that service: Clankie runs only on the owner's machine, and the gateway is only
the phone's encrypted doorway to it. Keeping the doorway's source private now
hides the one server between a phone and the owner's Mac, and makes every
gateway test drive this repository from a sibling checkout by path.

## Decision

- **Public (`clankie`)**: the gateway source, its tests and its image recipe in
  `apps/gateway`, built and checked with this workspace like any other app.
- **Private (`clankie-ops`)**: the Cognito accounts, the AWS templates and the
  deploy script and workflow, production configuration, observability, and App
  Store and launch records. `clankie-ops` builds the release image from a
  chosen ref of this repository's `apps/gateway`.
- `api.clankie.bot` stays the default doorway in the Mac and the app. An owner
  can read exactly what it runs, and can run their own copy. Whether the hosted
  doorway stays free is still undecided
  ([ADR 0204](0204-a-self-hosted-mac-pairs-the-app-directly.md)).
- The source was copied without its private history; earlier commits stay in
  `clankie-ops`.

## What the doorway can read

App traffic stays end-to-end encrypted: pairing, device sessions, conversation
and control, artifacts and terminal bytes cross the gateway as ciphertext that
only the Mac and the paired device can open
([ADR 0173](0173-the-gateway-cannot-read-device-traffic.md)).

The Claude connector route is the exception. `/h/{hostId}/mcp`, its OAuth
routes under `/h/{hostId}/oauth/` and its discovery documents
([ADR 0301](0301-claude-reaches-the-fleet-through-a-narrow-connector.md)) are
plaintext at the gateway, because Claude speaks ordinary OAuth and MCP. TLS
ends at the gateway's Caddy, so the gateway process can read the connector's
bearer, pane text and messages on their way to and from the Mac. The Mac still
authenticates every call. Publishing the source changes none of this; it lets
anyone check that this route is the only plaintext one.

## Alternatives considered

- **Keep the gateway private.** Rejected: with hosting gone it guards no
  business, and it keeps the phone's only server out of view.
- **Move deployment too.** Rejected: templates, account pools and production
  values describe James's AWS account, not something an owner runs.
- **Publish with history.** Rejected: older commits hold hosted-service and
  production records that ADR 0183 kept private.

## Consequences

- `pnpm check:landing` checks gateway changes here; `clankie-ops` runs the same
  suite from its sibling checkout before a release.
- A gateway change and the Mac change it needs can land in one commit, but the
  gateway still ships only when `clankie-ops` deploys it. Public releases never
  deploy the gateway.
- Secret scanning found only test placeholders in the published source.
