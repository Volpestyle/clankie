# ADR 0326: The last hosted leftovers are removed

Status: accepted (James, 2026-11-01: "Cut all four"). Supersedes
[ADR 0242](0242-every-clankie-has-a-mailbox-we-run.md). Completes
[ADR 0300](0300-clankie-runs-only-on-the-owners-machine.md) for the hosted
mailbox, the wake-key route, hosted browser-session pairing and the official
bot setting of [ADR 0241](0241-one-official-discord-bot-serves-every-clankie.md).

## Context

ADR 0300 made Clankie run only on the owner's machines and left the gateway as
the phone's encrypted doorway to the Mac. Four pieces of the hosted service
outlived it in this repository:

- the Clankie mailbox of ADR 0242: `@clankie/protocol/hosted-mail`, the mail
  port's hosted backend, `settings.email.provider`, and the account route
  `POST /v1/accounts/email/connect` with its `account_required` refusal,
  `clankie accounts connect email` and the TUI's "Clankie mailbox" choice;
- `POST /v1/devices/wake-key` in the gateway route list, which the Mac only
  answered with 404;
- the browser-session binding on pairing offers, with the device restart and
  session reissue it allowed, which only the hosted browser sign-in minted;
- `discord.officialBotEnabled`, the free shared bot through the hosted edge.

Each one is code to keep secure and to explain, for a service nobody runs.

## Decision

All four are removed.

- Mail is the owner's IMAP/SMTP server alone, connected with `/connect email`.
  The mail tools and the account catalog's `email` row are unchanged.
- The gateway no longer lists the wake-key route, so the Mac's encryption host
  refuses it before any local route sees it.
- A pairing offer always mints a new device. Redeeming an offer never resumes
  an existing device, and completion only activates a pending one; owner
  authentication, offer validation, expiry, single use and grant narrowing are
  unchanged.
- The owner's own bot and the lab user session are the Discord bodies.

## Consequences

- Older settings still load. `discord.officialBotEnabled` is dropped from a
  saved file and from a Discord settings save sent by an older client.
  `email.provider` is dropped; when it chose the Clankie mailbox, the address
  that service assigned goes too, so IMAP mail is not signed with it.
- An older event log still replays: a `device.pairing.restarted` event is read
  and ignored, and a stored `browserSessionId` is dropped.
- The private app's Connect Email button and its mailbox fixture use the
  removed route and `@clankie/api-client`'s `connectEmail`; the app answers the
  removal there.
