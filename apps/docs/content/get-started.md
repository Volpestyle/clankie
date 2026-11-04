# Get started

Clankie is an open-source, self-hosted super agent platform: it runs always-on
leads on your own machines, and those leads hire coding workers and report back.
Start on your Mac or Linux machine with your own agent subscriptions, models and
tools, then add leads and machines as you need them. The console, CLI, desktop
pet and phone app all reach the same service.

The software and Clankie accounts are free. An account is needed only for the
public gateway, which lets the app and connected apps reach your machine from
anywhere while it is awake; on your own network the app pairs with no account.
Model providers and connected services may charge. Check [clankie.bot](https://clankie.bot) for
current account signup and app install availability; a source capability does
not establish that a public install or account signup is open.

<a id="diy-start-on-your-mac"></a>

## DIY: install on your own machine

Clankie runs only on machines you own. One installer command picks the bundle
for your platform and brings its own runtime:

```sh
curl -fsSL https://clankie.bot/install | sh
```

It installs on Apple silicon Macs and on arm64 or x64 Linux. A Windows PC joins
an existing Clankie as a fleet machine until it can install Clankie itself.

### macOS

Apple silicon with **macOS 14 or newer**. The bundle needs Apple's Command Line
Tools, which provide `git` and `python3`; on a Mac without them the installer
opens Apple's install window and asks you to run it again afterwards (or run
`xcode-select --install` first).

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

### Linux

**Ubuntu 24.04 LTS or newer**, with glibc, on arm64 or x64. Install
`ca-certificates`, `curl`, `tar`, `coreutils`, `python3`, `git`, `procps` and
`lsof` with your package manager first; Node and Herdr are bundled.

The installer checksums the matching Linux archive and starts the service with
the portable launcher. No systemd user session is required; after logout or
reboot, run `clankie` again. Linux needs an official release that contains
`clankie-linux-arm64` or `clankie-linux-x64`; a release without Linux assets
cannot install on Linux. See
[distribution](https://github.com/Volpestyle/clankie/blob/main/docs/distribution.md#linux)
for prerequisites and lifecycle details. The
[Linux container deployment](https://github.com/Volpestyle/clankie/blob/main/infra/hosted/README.md)
remains available separately.

### Windows

The installer doesn't run on Windows yet. A Windows PC joins a Clankie running
on your Mac or Linux machine as a fleet machine: the service reaches it over SSH
and leads hire agents into its Herdr sessions.

```sh
clankie machines add pc --ssh my-pc --shell powershell
```

See [machines](/cli/#machines-list-discover-json) for discovery and the access
each machine gets.

<a id="set-him-up"></a>

### Set it up

Open a new terminal, run `clankie`, and choose **Run Clankie on this
computer**. The launcher starts the service and opens the console, and `/setup`
walks you through the rest:

1. **A model.** Connect a subscription, API key, or local provider, then pick a
   model. Sign-ins and keys go into the credential broker. Claude subscriptions
   aren't offered here: to lead from your Claude plan, run `clankie claude`,
   which opens Claude Code as a seat under its own sign-in
   ([seat commands](/cli/#seat-commands)). The model you pick still runs the
   built-in lead in the console, app and Discord.
2. **Your phone.** Setup signs this machine in for remote access and shows a
   pairing QR. Install the app, scan it, and accept.
3. **Services and a first agent.** Connect accounts with `/connect`, then give a
   first agent a folder and a task. Clankie handles the hire.

Run `clankie update` later to move to the latest release; a lead can update the
install the same way.

To lead from something other than the built-in lead, see
[bring your own lead](/diy/#bring-your-own-lead).

Everything after the model is optional. Escape or `/cancel` leaves setup;
`/setup` resumes from the actual device and agent state, and `/setup rooms`
lists the other settings.

The software is free; model providers and connected services may charge. See
[distribution](https://github.com/Volpestyle/clankie/blob/main/docs/distribution.md)
for checksums, pinning, and the installed layout, or
[contributing](https://github.com/Volpestyle/clankie/blob/main/CONTRIBUTING.md)
to run from source.

## Bring your Mac's Clankie into the app

`/setup` does this for you. By hand:

1. **Pick a route.** `/remote-access` signs the Mac in with an emailed code so
   the app can reach it from anywhere. `clankie gateway direct` instead
   advertises a route on a network your phone can reach, with no account.
2. **Keep it running.** `clankie autostart enable` starts the service at login. The Mac
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

`clankie transfer` moves your Clankie to another machine you already have access
to, and back. One machine holds it at a time: the old one freezes before anything
is copied, and it serves only a note saying where it went. Identity, memory,
conversations, projects and tracker move. Credentials, model and harness
sign-ins and paired devices stay where they are: pair your devices with the
new machine and connect accounts there. Your Mac can then join it as a fleet
machine, so workers still run on it
([ADR 0286](https://github.com/Volpestyle/clankie/blob/main/docs/adr/0286-one-body-holds-clankie-at-a-time.md)).

## Your first conversation

Try: “Help me turn this idea into a plan, and remember that I prefer short,
practical answers.” For bigger work, ask your lead to explain its plan first and
show you the result.

Next: [using Clankie](/using-clankie/), or [customize it](/diy/).

<a id="if-you-cannot-reach-him"></a>

## If you cannot reach your machine

| What you see                  | Where to start                                                             |
| ----------------------------- | -------------------------------------------------------------------------- |
| Local console cannot answer   | `clankie doctor` and `clankie status`; `/setup` fixes a missing model.     |
| App cannot reach your Mac     | Is the Mac awake and online? Then check remote access or the direct route. |
| Pairing offer expired or used | Make a new offer and use its full link or QR.                              |
| Account or remote access      | Check your account, then [support](https://clankie.bot/support/).          |
| A feature is unavailable      | Ask Clankie what is configured, or see [the reference](/reference/).       |

Share error messages and versions with support, never pairing links, keys, or
sign-in codes.
