# Get started

Clankie is a personal assistant with a memory, a personality, and tools to get
things done. You can have his machine looked after for you, or run him yourself.
Choose the setup you want; both start with a conversation.

|                           | Hosted Clankie                                   | Run him yourself                                                        |
| ------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------- |
| Where he lives            | A private machine managed for you                | Your Mac, or an advanced Linux deployment                               |
| Start here                | Your account and the iPhone or iPad app          | Install, connect a model, open the console                              |
| Models                    | Included usage or your own supported credentials | Your provider subscription, API key, or local model                     |
| Optional depth            | Helper agents and the app's work views           | Models, skills, coding agents, Discord, voice, and service integrations |
| Who maintains the machine | The hosted service                               | You                                                                     |

Current plans and app availability live on [clankie.bot](https://clankie.bot).
The Discord calls and game night in the promo use the Mac setup; they are not
part of the hosted app experience advertised there.

## Hosted: start in the app

1. Open [Get Clankie](https://clankie.bot/#get) to create or sign in to your
   account and set up your Clankie.
2. Get the iPhone or iPad app from the [official app link](https://clankie.bot/#app).
   That page names the current distribution channel.
3. Follow your account's pairing flow, then open **Messages** and choose
   **Clankie**. Say hello, tell him what you are working on, or ask for help.

Your account manages the hosted machine and plan. The app is where you talk
to him. You do not need to install the Mac service to use hosted Clankie.

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

Once he can answer, say hello. `/setup` lists optional features and can hand
the walkthrough to Clankie. You can add those later; an app account, Discord,
and worker agents are not required for a local conversation.

The software is free to run. Your model providers and other connected services
may charge for use. See [installation details](https://github.com/Volpestyle/clankie/blob/main/docs/distribution.md)
for checksums, version pinning, and the installed layout. Developers can
[run from source](https://github.com/Volpestyle/clankie/blob/main/CONTRIBUTING.md);
experienced operators can use the [Linux deployment](https://github.com/Volpestyle/clankie/blob/main/infra/hosted/README.md).

## Bring your Mac's Clankie into the app

1. In the console, open `/remote-access` and choose **Enable remote access**.
   Sign in with your Clankie account using the emailed code. If your account
   cannot enroll a machine, use [support](https://clankie.bot/support/).
2. Run `clankie autostart enable` if you want him to start when you log in.
   Leave the Mac awake and online while you want to reach it.
3. Install the app through the [official app link](https://clankie.bot/#app).
4. Run `clankie pair`. Scan the secure QR or paste the **complete secure link**
   into the app, review the offered access, and connect.

Pairing offers are single-use. Short codes are for direct private connections;
internet pairing needs the QR or complete link. `clankie devices` lists paired
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

| What you see                              | Where to start                                                                   |
| ----------------------------------------- | -------------------------------------------------------------------------------- |
| Local console cannot answer               | Run `clankie doctor` and `clankie status`; `/setup` handles missing model setup. |
| App cannot reach your Mac                 | Check that the Mac is awake, online, and signed in for remote access.            |
| Pairing offer expired or was already used | Create a new offer; use its full secure link or QR.                              |
| Hosted connection or account problem      | Check your account, then use [support](https://clankie.bot/support/).            |
| A particular feature is unavailable       | Ask Clankie what is configured, or consult [the reference index](/reference/).   |

Share error messages and versions with support, never pairing links, keys, or
sign-in codes.
