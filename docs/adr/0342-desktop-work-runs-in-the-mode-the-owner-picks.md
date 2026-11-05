# ADR 0342: Desktop work runs in the mode the owner picks

Status: Proposed, 2026-11-02, from James's direction the same day ("Clankie will
have a setting for how it does desktop use, 'raw-dog' or 'vm'", and "private
browser is ok as long as we have a way to securely store and pass credentials"). Amended the same day: agents get only their own private browser by default, full
screen control is its own `screen` mode, the VM is a sandbox option, and a lead
may carry its own mode. The mode is a Common setting, with a Mac app page that
checks each opt-in mode's macOS permissions.
Tracks [#229](https://github.com/Volpestyle/clankie/issues/229). Narrows
[ADR 0199](0199-hard-computer-work-goes-to-a-computer-use-harness.md) (hard
computer work goes to a computer-use harness) by saying _where_ that harness
may act. Keeps [ADR 0082](0082-clankie-holds-the-browser.md) and
[ADR 0127](0127-his-accounts-are-his.md) (his own browser and accounts),
[ADR 0244](0244-machines-join-clankie-at-an-access-level.md) (each machine's
owner-chosen screen ceiling) and
[ADR 0255](0255-a-lent-screen-keeps-consent-and-stops-on-its-host.md) (a lent
screen keeps consent and stops on its host). Owner-machine-only, per
[ADR 0300](0300-clankie-runs-only-on-the-owners-machine.md).

## Context

On 2026-11-01 a hired worker drove James's own Chrome while he was using his
Mac, to fill in a GitHub App form. Nothing told it not to, and nothing gave it
somewhere else to work. The hire brief and the `desktop-control` and `lead`
skills now say the owner's screen is his (#230), but a rule is not a place:
some work really needs a desktop, and today the only desktop a worker can reach
is the owner's.

There are three honest places for that work:

- **Nowhere visible.** Most "desktop" work is web work. Clankie already holds a
  private headless browser with its own profile (ADR 0082). What it lacks is a
  safe way to sign in there as the owner: today a worker either asks the owner
  to type a password into chat, which is wrong, or drives the owner's own
  signed-in Chrome, which is the screen takeover.
- **The owner's own Mac, in the background.** Codex computer use and
  agent-desktop's accessibility actions can press and type into an app's
  accessibility tree without bringing it to the front or moving the pointer.
  This reaches the owner's real apps and sessions. It cannot do everything:
  some apps ignore background input, and a form in a window the owner is
  looking at still changes under his hands.
- **A desktop of its own.** Apple's Virtualization framework boots a full macOS
  guest on Apple silicon (Tart, Lume and VirtualBuddy all use it). An agent
  running agent-desktop inside the guest sees only the guest. The owner keeps
  working; the agent can click, type and front windows freely, because they
  are its windows. The cost is disk (a guest image is tens of gigabytes), RAM
  while it runs, and sign-ins made again inside the guest.

Each fits a different owner, and none of them is the starting point. By
default an agent gets only its own private browser, in a Herdr browser pane
where the workspace has one (ADR 0344), with no reach into the owner's
desktop, apps or signed-in browsers. On top of that, some owners want agents in
their real apps in the background, through the accessibility tree, without
taking the pointer. Some want an agent to drive their screen outright. Some want a
sandbox, so an agent's clicks land in a guest that can be thrown away. And a
connected lead such as Grok Bot may bring a VM of its own. James's direction
(2026-11-02): the VM is a sandbox option, not the way to keep agents off the
owner's screen, and every one of these should be a choice the owner makes.

## Decision

**Desktop work runs in one mode the owner picks, per machine:
`computer.desktopMode` = `host` | `screen` | `vm` | `none`, with an
override per lead.**

| Mode     | Where the work happens                                                                                                                                                    | Default                                       |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `none`   | No desktop. The agent gets only its own private browser: a Herdr browser pane where there is one, otherwise a headless browser. A hire that needs a native app is refused | Yes, on every install                         |
| `host`   | The owner's own Mac, in the background only: accessibility actions and background computer use, never the pointer or the front window                                     | Opt-in, needs the machine's screen ceiling on |
| `screen` | The owner's own screen, in full: the agent may front windows, move the pointer and type, as the owner would                                                               | Opt-in, needs the machine's screen ceiling on |
| `vm`     | A macOS guest on this Mac, booted with the Virtualization framework, with agent-desktop inside it: a sandbox                                                              | Opt-in, needs the disk room                   |

**Per lead.** `computer.desktopMode` is the machine's default. A connected lead
can carry its own mode for the hires it leads, set by the owner: Grok Bot's
hires can go to a VM while Claude Duet's work in the background on the host.
A lead that brings its own VM or desktop declares it when it connects (see
"A connected app's own browser, desktop or vault comes first" below), and then
Clankie's mode does not apply to that lead at all.

**A hire asks for a desktop; Clankie routes it.** `start_agent` and
`hire_agent` take `desktop: true` when the work needs a screen. Clankie reads
the machine's mode and either:

- `host`: starts it with the background-only screen rule from #230 in its
  brief and a Codex computer-use or agent-desktop seat; anything that can only
  happen in front of the owner stops and goes to the lead;
- `screen`: starts it with a seat that may drive the owner's screen in full
  (agent-desktop with its focus and mouse commands, Peekaboo in the
  foreground, a Claude in Chrome seat); the brief says the owner chose this;
- `none`: starts the hire without a desktop and tells it to use a browser pane
  or a private browser, or refuses with "this machine has no desktop for
  agents; the owner can turn one on with `clankie computer mode host|screen|vm`"
  when the brief needs a native app;
- `vm`: starts the guest if it is stopped (headless, no window on the owner's
  screen), and starts the hire with its desktop tools pointed into the guest.
  Inside the guest the agent may front windows and use the mouse.

A hire that does not ask for a desktop never gets one, in any mode. The
machine's ADR 0244 screen ceiling still caps every mode: `host` and `screen`
need the screen ceiling on; `vm` does not use the owner's screen and only needs
`workers`.

**The setting lives in the CLI first and is Common.**
`clankie computer mode [host|screen|vm|none] [--machine ID] [--lead NAME] --json`
shows and sets it; `--lead` sets that lead's override.
`clankie computer permissions [--machine ID] --json` reports, for each mode,
what it needs and whether that is in place. `clankie computer vm
status|start|stop|create` manages the guest: `create` says the image size and
free disk and needs `--yes`, because it downloads macOS and spends tens of
gigabytes. `clankie doctor` reports the mode, and for `vm` whether the guest
exists, runs, and has agent-desktop and a browser inside. The same API backs
the app. The setting goes in the [settings inventory](../settings-inventory.md)
under Common.

**The Mac app has a page for it.** James approved a mock on 2026-11-02
([clankie-app#41](https://github.com/Volpestyle/clankie-app/issues/41)).
The page is titled "How much of your Mac can agents use?" and has one card per
mode, in plain words. "Their own browser only" (`none`) is preselected and
needs nothing, so skipping the page changes nothing. Each other card lists only
what its mode needs:

- `host`: Accessibility for the app that hosts the agents' terminals (Herdr
  Browser on James's Mac).
- `screen`: Accessibility and Screen Recording for that same app.
- `vm`: enough free disk, and a guest that exists and is ready.

A missing grant shows "Open Settings", which opens that pane of System
Settings, and the row checks again when the app returns to the front. macOS
gives a grant to the process that acts, so each check runs where the agents run
(for example `agent-desktop status` in a terminal of that app), never from the
Clankie app's own process. The page appears as an optional step in first setup
and in the Mac's Settings. Phone and web show the chosen mode and whether its
grants are on, and send the owner to the Mac to allow anything.

**Sign-ins go through a credential vault the model never reads.**
James set the condition: the private browser is fine only with a secure way to
store and pass credentials, the way Grok Bot and Muse do it. So:

- When an agent reaches a sign-in, it calls `request_credential` with the
  site's origin (for example `https://github.com`) and the field shape
  (username and password, or a one-time code). It never names or sees a value.
- Clankie shows the owner a small sign-in card on the surface he is using: the
  app's feed, the desktop pet, the TUI or a Discord DM from the official bot to
  him.
  The card names the agent, the machine, the site and why it was asked. He
  types the username and password there, chooses "fill once" or "save for this
  site", or declines.
- The secret goes from that card over the existing encrypted doorway straight
  to the credential broker on the Mac, and from the broker straight into the
  browser field through the browser's own fill (CDP `Input.insertText` on the
  focused field in the private browser, agent-desktop's set-value inside the
  guest). It never enters a model context, a transcript, a tool result, a log,
  the notes board or a work record. Tool results say only `filled`,
  `declined`, `saved` or `failed`.
- On a terminal, the same card is a modal in the Clankie TUI (and
  `clankie credentials answer` in a plain shell): a masked input that reads
  keystrokes with echo off and sends them over the local API straight to the
  broker. Nothing is written to the console's chat log, the seat's transcript
  or scrollback. The hire's own Herdr pane never takes the secret: it shows
  only that it is waiting for a sign-in to that origin and where the owner can
  answer, and typing a password into an agent's pane is never the route,
  because the pane is the agent's input and its transcript.
- Saved credentials live in the broker (Keychain on macOS), scoped to the
  exact origin, one entry per origin and username. A fill is allowed only into
  a page whose top-level origin matches exactly; a redirect, an iframe on
  another origin or a lookalike domain gets `failed` and the owner sees why.
- The agent can ask for a fill by origin, never read a value back. There is no
  tool that returns a stored secret.
- Two-factor prompts get the same card with one code field. A code is used
  once and never stored. Push approvals and passkeys stay on the owner's own
  device; the card says to approve there.
- `clankie credentials list|revoke ORIGIN` and the app's account page show what
  is saved and remove it. Every fill writes an audit line (time, agent,
  machine, origin, username, fill or decline, mode) to the event log, never the
  secret. `clankie credentials log` reads it.

**James asked whether `host` mode still wants this.** Yes, with one difference.
In `host` mode the owner's own Chrome is usually already signed in, and many
owners keep a password manager. So in `host` mode the vault is still how a
private-browser or background seat signs in, and `computer.passwordManager`
may name the owner's manager (`1password` first, through its own CLI and
desktop-app approval) to fill from instead of saving a second copy. The
manager's own approval prompt is the owner's consent; Clankie stores nothing.
In `vm` mode the vault is the only way, because the guest starts with no
sign-ins and should not get the owner's whole password manager.

**A connected app's own browser, desktop or vault comes first.** James's
rule: a connected lead such as Grok Bot or Muse may already give its agents a
sandboxed browser or desktop and its own sign-in prompts, and Clankie should
not build a second one beside it. So a connected app may declare, when it
connects, which of `browser`, `desktop` and `credentials` it supplies. When the
lead behind a hire declares one, Clankie leaves that part to the lead: the
hire's brief says to use the lead's tool, `request_credential` is not offered,
and the desktop mode is not consulted for that part. What the lead does not
supply falls back to Clankie's own modes and vault. `clankie doctor` names
which app supplies what on each machine. A connected app never gets a stored
secret from Clankie's vault; the two vaults stay separate.

## Consequences

- The screen takeover of 2026-11-01 has nowhere to happen by default: a new
  install gives agents only their own private browser. Background control
  (`host`), full control (`screen`) and a sandbox (`vm`) each start only when
  the owner turns them on, for a machine or for one lead.
- James picks his Mac's mode. Its `clankie-desktop` guest is ready for a lead
  or task he wants sandboxed, with any sign-in made inside it through the vault
  card (and a 2FA code through the same card).
- New code: the `computer.desktopMode` setting and CLI, hire routing and the
  `desktop` hire flag, the guest manager over Tart or Lume (whichever the
  owner's Mac already has; Tart first otherwise), the vault card on the app,
  pet and Discord, the broker fill path and its audit log. Each lands with an
  E2E test against the real browser or guest (ADR 0221).
- The vault card is a new place a secret is typed. It inherits the doorway's
  encryption and the broker's Keychain storage, and adds an exact-origin check
  that the old "type it into chat" path never had.
- Connected apps that already solve this keep solving it; Clankie's modes and
  vault are the fallback for owners whose lead has neither.
- What this ADR does not do: no hosted desktop (ADR 0300), no shared desktop
  between owners, no automatic account creation (ADR 0127 still holds), and no
  driving the owner's foreground windows in any mode.

## Implementation boundary (core #300)

The typed owner choice, per-lead override, revision-fenced write, machine
inventory projection and actor-context permission report are implemented through
[`desktop-access.ts`](../../packages/protocol/src/desktop-access.ts) and the
[CLI/API guide](../desktop-control.md#desktop-choice-and-permission-status).
Reads never run a service-context TCC check. The owner explicitly refreshes a
named actor report from the acting terminal; unavailable status stays unknown.
Neither a report nor a choice raises a machine ceiling. This does not claim the
proposed hire routing, guest manager or credential vault is built. Those remain
separate work; no VM is created or started by saving a choice.

## Implementation boundary (#245, first slice)

Sign-in requests for Clankie's own private browser are built: the
`clankie_request_credential` worker tool (a hire admitted on this Mac names the
browser conversation, the exact origin and the field shape), `/credentials` in
the TUI and `clankie credentials answer` in a plain shell (masked, echo off,
over the local owner API), and the broker fill
([`credential-requests.ts`](../../apps/clankie/src/credential-requests.ts),
[`browser-host.ts`](../../apps/clankie/src/browser-host.ts)). The guide is
[sign-in requests](../credentials.md#sign-in-requests).

The post-fill handoff is broker-controlled submit plus retirement (lead
decision): while a request is open its tab is sealed (no browser tool reaches
it, and no conversation runs browser JavaScript, whose root CDP reaches every
tab). On an answer, the broker loads the bound page fresh, checks the top
document, every field and the form's action are the exact origin and the form
posts, types the values, submits the form itself and closes the tab. The worker
gets a new tab in the same session at the landing page, or a blank one on any
failure; access to the tab that held the secret never returns. A decline,
withdrawal or expiry returns the untouched tab.

Not built in this slice: the app, pet and Discord cards, saving a login
("save for this site" and the `saved` result), `clankie credentials
list|revoke|log` over saved logins, the guest fill and password managers. Two
gaps are left for review: any process of the owner's user can still reach the
private Chrome's DevTools port directly (a pipe transport would close it), and
Chrome's own password manager in a headed window may offer to save what was
typed.
