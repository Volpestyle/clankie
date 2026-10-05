# Get started

Clankie is a personal assistant with a memory, a personality, and tools to get
things done. You can have his machine looked after for you, or run him yourself.
Choose the setup you want; both start with a conversation.

|                           | Hosted Clankie                          | Run him yourself                                                        |
| ------------------------- | --------------------------------------- | ----------------------------------------------------------------------- |
| Where he lives            | A private machine managed for you       | Your Mac, or an advanced Linux deployment                               |
| Start here                | Your account and the iPhone or iPad app | Install, connect a model, open the console                              |
| Models                    | AI credits from your plan or account    | Your provider subscription, API key, or local model                     |
| Optional depth            | Helper agents and the app's work views  | Models, skills, coding agents, Discord, voice, and service integrations |
| Who maintains the machine | The hosted service                      | You                                                                     |

Current plans and app availability live on [clankie.bot](https://clankie.bot).
The Discord calls and game night in the promo use the Mac setup; they are not
part of the hosted app experience advertised there.

## Hosted: start in the app

New hosted signup is currently closed. The steps below describe the journey
when signup opens and the app can be installed; existing accounts can still
sign in.

1. Check the [official app link](https://clankie.bot/#app) to make sure you can
   install the iPhone or iPad app before buying a plan. That page names the
   current distribution channel.
2. Open [Get Clankie](https://clankie.bot/#get) to create or sign in to your
   account. Choose a plan with AI credits and complete checkout. A machine-only
   plan needs a pack or top-up from your account before Clankie can answer.
3. Your account shows when Clankie is ready. Open its secure app link on your
   iPhone or iPad, review the connection, and connect. If you are using another
   screen, scan the QR or copy the complete secure link into the app.
4. Open **Messages** and choose **Clankie**. Say hello, tell him what you are
   working on, or ask for help.

Your account manages the hosted machine and plan. The app is where you talk
to him. Your first conversation uses the managed model; you do not need a
Mac installation, a model subscription, or an API key. If your AI credits run
out, return to your account to add credits.

Prefer a terminal as well? The Mac console can connect to an existing hosted
Clankie with `clankie connect hosted`. The [connection reference](/cli/#local-and-hosted-connection-modes)
explains sign-in, supported commands, and device revocation.

## DIY: start on your Mac

The downloadable bundle supports **Apple silicon and macOS 14 or newer**.
It includes the runtime; you do not need Node or a source checkout.

```sh
curl -fsSL https://raw.githubusercontent.com/Volpestyle/clankie/main/install.sh | sh
clankie
```

On first launch, choose **Run Clankie on this Mac**. The launcher starts his
service and opens the terminal console. `/setup` asks how he should think:
connect a supported subscription, API key, or local provider, then choose a
model. Sign-ins and keys go into the credential broker.

Stay in `/setup`: it next signs this Mac in for phone access and opens the
pairing QR. Open the app from the [official app link](https://clankie.bot/#app),
scan the QR and accept access. Setup waits until your phone is active, then
lets you connect services through `/connect` and give your first agent a folder
and a task. Review and send the request to Clankie; he handles the native hire
and any harness sign-in. `/agents` opens the team once a live seat is observed.

Each optional step can be skipped, and Escape or `/cancel` stops the flow.
Return to `/setup` to continue from the actual device and agent state.
`/setup rooms` lists the other settings. An app account, Discord and worker
agents are not required for a local conversation.

The software is free to run. Your model providers and other connected services
may charge for use. See [installation details](https://github.com/Volpestyle/clankie/blob/main/docs/distribution.md)
for checksums, version pinning, and the installed layout. Developers can
[run from source](https://github.com/Volpestyle/clankie/blob/main/CONTRIBUTING.md);
experienced operators can use the [Linux deployment](https://github.com/Volpestyle/clankie/blob/main/infra/hosted/README.md).

## Bring your Mac's Clankie into the app

The guided `/setup` path handles sign-in and pairing. For individual steps or
a direct route:

1. Choose a route to your Mac. For account-based remote access, open
   `/remote-access` and sign in with the emailed code. For a direct connection
   on your own network, configure a device-reachable direct route with
   `clankie gateway direct`; this path does not require a Clankie account.
   The [pairing reference](/cli/#pair-json-timeout-sec-review-days-n-count-n)
   explains the device doorway and supported addresses.
2. Run `clankie autostart enable` if you want him to start when you log in.
   Leave the Mac awake and online while you want to reach it. Optionally run
   [`clankie awake on`](/cli/#awake) to keep it awake while plugged in.
3. Install the app through the [official app link](https://clankie.bot/#app).
4. Run `clankie pair`. Scan the secure QR or paste the **complete secure link**
   into the app, review the offered access, and connect.

Pairing offers are single-use. The QR or complete link carries the configured
gateway and direct routes; the app prefers the gateway when both are available.
Short codes are for direct private connections. `clankie devices` lists paired
devices and lets you revoke them. The [pairing reference](/cli/#pair-json-timeout-sec-review-days-n-count-n) covers
options and recovery.

Closing the console leaves the local service running. Sleeping or shutting down
the Mac makes that Clankie unavailable until the machine returns. Pairing the
app does not move a local Clankie to hosted infrastructure.

## Your first conversation

Try: “I'm putting together a small project. Help me turn this idea into a plan,
and remember that I prefer short, practical answers.” Give him the idea and
any constraints that matter. For a bigger task, ask him to explain his plan
and show the result when it is ready.

Next: [using Clankie](/using-clankie/) for everyday requests and working with
his team, or [customize Clankie](/diy/) with models, skills, and connections.

## If you cannot reach him

| What you see                              | Where to start                                                                                           |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Local console cannot answer               | Run `clankie doctor` and `clankie status`; `/setup` handles missing model setup.                         |
| App cannot reach your Mac                 | Check that the Mac is awake and online, then check remote-access sign-in or the configured direct route. |
| Pairing offer expired or was already used | Create a new offer; use its full secure link or QR.                                                      |
| Hosted connection or account problem      | Check your account, then use [support](https://clankie.bot/support/).                                    |
| A particular feature is unavailable       | Ask Clankie what is configured, or consult [the reference index](/reference/).                           |

Share error messages and versions with support, never pairing links, keys, or
sign-in codes.
