# Get started

Clankie is an agent lead with a memory and a personality: he plans the work,
leads a team to do it, and owns it until it lands. Start on your Mac with your
own agent subscriptions, models and tools. The desktop pet is the front door;
the TUI, CLI and phone app reach the same lead.

The software and Clankie accounts are free. An account supports pairing, phone
steering while your Mac is awake and the official Discord bot. Model providers
and connected services may charge. Check [clankie.bot](https://clankie.bot) for
current account signup and app install availability; a source capability does
not establish that a public install or account signup is open.

## DIY: start on your Mac

The bundle supports **Apple silicon and macOS 14 or newer** and includes its
own runtime.

```sh
curl -fsSL https://clankie.bot/install | sh
```

When a Mac release includes the approved companion pin, installation also
writes `Clankie.app` to `/Applications` and opens it with a private local
pairing handoff. The Mac starts with the desktop pet; the World window is
opt-in. For a terminal-only install:

```sh
curl -fsSL https://clankie.bot/install | sh -s -- --no-app
```

Updates remember that choice. **The signed companion release is not available
yet**, so the current installer supplies the terminal bundle only
([distribution](https://github.com/Volpestyle/clankie/blob/main/docs/distribution.md#mac-companion-app)).

Open a new Terminal window, run `clankie`, and choose **Run Clankie on this
computer**. The launcher starts his service and opens the console, and `/setup`
walks you through the rest:

1. **A model.** Connect a subscription, API key, or local provider, then pick a
   model. Sign-ins and keys go into the credential broker.
2. **Your phone.** Setup signs this Mac in for remote access and shows a pairing
   QR. Install the app, scan it, and accept.
3. **Services and a first agent.** Connect accounts with `/connect`, then give a
   first agent a folder and a task. Clankie handles the hire.

Run `clankie update` later to move to the latest release; Clankie can update
himself the same way.

Everything after the model is optional. Escape or `/cancel` leaves setup;
`/setup` resumes from the actual device and agent state, and `/setup rooms`
lists the other settings.

The software is free; model providers and connected services may charge. See
[distribution](https://github.com/Volpestyle/clankie/blob/main/docs/distribution.md)
for checksums, pinning, and the installed layout,
[contributing](https://github.com/Volpestyle/clankie/blob/main/CONTRIBUTING.md)
to run from source, or the
[Linux deployment](https://github.com/Volpestyle/clankie/blob/main/infra/hosted/README.md).

## Existing hosted accounts

If your account already has a hosted body, open its secure app link on your
phone (or scan its QR), review the access, and connect. Open **Messages**, choose
**Clankie**, and say hello. To reach that existing body from a terminal, use
`clankie connect hosted` ([connection modes](/cli/#local-and-hosted-connection-modes)).
See [hosted support](https://github.com/Volpestyle/clankie/blob/main/infra/hosted/README.md)
for its limits and recovery. Signing into a free account does not create a
hosted body.

## Linux release path

Linux bundles support **Ubuntu 24.04 LTS or newer**, with glibc, on arm64 or x64.
Install `ca-certificates`, `curl`, `tar`, `coreutils`, `python3`, `git`, `procps`
and `lsof` using your package manager. Node and Herdr are bundled.

The same installer selects and checksums the matching Linux archive, then starts
the service with the portable launcher. Run `clankie`, choose local, and enter
`/setup`. Model authentication, remote phone access and optional worker harnesses
use the same setup flow. No systemd user session is required. After logout or
reboot, run `clankie` again; `clankie update` follows the Linux release target.

This path requires an official release containing `clankie-linux-arm64` or
`clankie-linux-x64`; a release without Linux assets cannot install on Linux.
See [distribution](https://github.com/Volpestyle/clankie/blob/main/docs/distribution.md#linux)
for prerequisites and lifecycle details. The
[hosted Linux deployment](https://github.com/Volpestyle/clankie/blob/main/infra/hosted/README.md)
remains available separately.

## Bring your Mac's Clankie into the app

`/setup` does this for you. By hand:

1. **Pick a route.** `/remote-access` signs the Mac in with an emailed code so
   the app can reach it from anywhere. `clankie gateway direct` instead
   advertises a route on a network your phone can reach, with no account.
2. **Keep him running.** `clankie autostart enable` starts him at login. The Mac
   stays awake while plugged in by default; [`clankie awake off`](/cli/#awake)
   lets it sleep.
3. **Pair.** Run `clankie pair`, then scan the QR or paste the complete secure
   link into the app.

Offers are single-use and carry every configured route; the app prefers the
gateway. Short codes work only over a direct private route. `clankie devices`
lists and revokes paired devices. The
[pairing reference](/cli/#pair-json-timeout-sec-review-days-n-count-n) covers
options and recovery.

Closing the console leaves the service running, but a sleeping or offline Mac
cannot be reached. Pairing does not move your Clankie anywhere.

## Move your Clankie to another body

`clankie transfer` moves the same Clankie to another body, that you already have access to,
and back. One body holds him at a time: the old one freezes before anything is
copied, and it serves only a note saying where he went. His identity, memory,
conversations, projects and tracker move. Credentials, model and harness
sign-ins and paired devices stay where they are: pair your devices with the
new body and connect accounts there. Your Mac can then join the new body as a
machine, so his workers still run on it
([ADR 0286](https://github.com/Volpestyle/clankie/blob/main/docs/adr/0286-one-body-holds-clankie-at-a-time.md)).
With a hosted Clankie connected (`clankie connect hosted`),
`clankie transfer --to hosted` moves your Mac's Clankie there, and
`clankie transfer --from hosted --to local` brings him back. Hosted transfer is
not available yet: it is proven against a test gateway and waits for the hosted
service update.

## Your first conversation

Try: “Help me turn this idea into a plan, and remember that I prefer short,
practical answers.” For bigger work, ask him to explain his plan first and show
you the result.

Next: [using Clankie](/using-clankie/), or [customize him](/diy/).

## If you cannot reach him

| What you see                  | Where to start                                                             |
| ----------------------------- | -------------------------------------------------------------------------- |
| Local console cannot answer   | `clankie doctor` and `clankie status`; `/setup` fixes a missing model.     |
| App cannot reach your Mac     | Is the Mac awake and online? Then check remote access or the direct route. |
| Pairing offer expired or used | Make a new offer and use its full link or QR.                              |
| Hosted account or connection  | Check your account, then [support](https://clankie.bot/support/).          |
| A feature is unavailable      | Ask Clankie what is configured, or see [the reference](/reference/).       |

Share error messages and versions with support, never pairing links, keys, or
sign-in codes.
