# ADR 0300: Clankie runs only on the owner's machine

Status: Accepted by James, 2026-10-29. Retires the hosted body of
[ADR 0183](0183-the-harness-is-public-the-hosted-service-is-private.md),
[ADR 0237](0237-hosted-bodies-update-themselves-to-official-releases.md),
[ADR 0241](0241-one-official-discord-bot-serves-every-clankie.md) and
[ADR 0285](0285-hosted-presence-has-no-idle-clock.md). Keeps
[ADR 0204](0204-a-self-hosted-mac-pairs-the-app-directly.md) and
[ADR 0286](0286-one-body-holds-clankie-at-a-time.md).

## Context

Clankie grew two products: the agent on the owner's own always-on machine, and
a managed body that Clankie ran for a customer in the cloud, with a runtime
provider, hosted pairing and support, wake keys, a hosted operator bridge, a
managed and an official Discord bot, a hosted Activity viewer and a hosted mode
in the CLI. Hosted pricing is gone, nobody installs the managed body, and every
hosted path is extra code to keep secure and working.

## Decision

Clankie runs only on machines the owner controls. The core keeps:

- the public gateway connector and gateway encryption, so the phone reaches the
  owner's Mac through `api.clankie.bot` without the gateway reading traffic;
- account sign-in for that doorway (`clankie login`, `clankie remote-access on`);
- direct LAN pairing, body transfer between the owner's own machines and the
  dormant body;
- support grants that the owner issues, and the account mailbox route.

It removes the managed body and its runtime provider, hosted pairing, support
and device security, wake keys, the hosted operator bridge, managed and official
Discord ingress, the hosted Activity runtime and viewer, and the CLI's hosted
mode. `packages/protocol` keeps its hosted modules for now, because the app and
the gateway still import them; they go when those consumers do.

## Consequences

- `clankie connect hosted` and `clankie transfer --to hosted` are gone.
  `clankie login` always signs this Mac in for remote access.
- Old settings with `client.mode: "hosted"` still parse and run as local.
- The gateway service in `clankie-ops` drops its fleet control plane, managed
  body and Discord edge in the same change set; live hosted infrastructure has
  to be decommissioned before the next gateway deploy.
