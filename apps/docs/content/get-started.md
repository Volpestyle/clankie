# Get started

Clankie is an agent lead with a memory and a personality: he plans the work,
leads a team to do it, and owns it until it lands. Have his machine looked after
for you, or run him yourself.

|                  | Hosted Clankie                          | Run him yourself                                    |
| ---------------- | --------------------------------------- | --------------------------------------------------- |
| Where he lives   | A private machine managed for you       | Your Mac, or an advanced Linux deployment           |
| Start here       | Your account and the iPhone or iPad app | Install, connect a model, open the console          |
| Models           | AI credits from your plan or account    | Your provider subscription, API key, or local model |
| Who maintains it | The hosted service                      | You                                                 |

[clankie.bot](https://clankie.bot) says whether hosted sign-up and app installs
are open and lists current plans. The Discord calls and game night in the promo
use the Mac setup.

## Hosted: start in the app

1. Check that you can install the iPhone or iPad app from the
   [official app link](https://clankie.bot/#app).
2. Open [Get Clankie](https://clankie.bot/#get), sign in or create an account,
   and choose a plan with AI credits. A machine-only plan needs credits added
   before Clankie can answer.
3. When your account shows Clankie is ready, open its secure app link on your
   phone (or scan its QR), review the access, and connect.
4. Open **Messages**, choose **Clankie**, and say hello.

You need no Mac install, model subscription, or API key. Add credits from your
account if they run out. To use a terminal as well, run `clankie connect hosted`
on a Mac ([connection modes](/cli/#local-and-hosted-connection-modes)).

## DIY: start on your Mac

The bundle supports **Apple silicon and macOS 14 or newer** and includes its
own runtime.

```sh
curl -fsSL https://clankie.bot/install | sh
```

When a Mac release includes the approved companion pin, installation also
writes `Clankie.app` to `/Applications` and opens it with a private local
pairing handoff. For a terminal-only install, add `sh -s -- --no-app` to the
command above; updates remember that choice. Companion distribution is still
gated on the signed app release ([distribution](https://github.com/Volpestyle/clankie/blob/main/docs/distribution.md#mac-companion-app)).

Open a new Terminal window, run `clankie`, and choose **Run Clankie on this
Mac**. The launcher starts his service and opens the console, and `/setup`
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

## Bring your Mac's Clankie into the app

`/setup` does this for you. By hand:

1. **Pick a route.** `/remote-access` signs the Mac in with an emailed code so
   the app can reach it from anywhere. `clankie gateway direct` instead
   advertises a route on a network your phone can reach, with no account.
2. **Keep him running.** `clankie autostart enable` starts him at login, and
   [`clankie awake on`](/cli/#awake) keeps the Mac awake while plugged in.
3. **Pair.** Run `clankie pair`, then scan the QR or paste the complete secure
   link into the app.

Offers are single-use and carry every configured route; the app prefers the
gateway. Short codes work only over a direct private route. `clankie devices`
lists and revokes paired devices. The
[pairing reference](/cli/#pair-json-timeout-sec-review-days-n-count-n) covers
options and recovery.

Closing the console leaves the service running, but a sleeping or offline Mac
cannot be reached. Pairing does not move your Clankie to hosted infrastructure.

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
