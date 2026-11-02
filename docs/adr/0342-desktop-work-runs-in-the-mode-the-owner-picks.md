# ADR 0342: Desktop work runs in the mode the owner picks

Status: Proposed, 2026-11-02, from James's direction the same day ("Clankie will
have a setting for how it does desktop use, 'raw-dog' or 'vm'", and "private
browser is ok as long as we have a way to securely store and pass credentials").
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

Each fits a different owner. A new user with no spare disk wants the first; an
owner who trusts the agent with his real apps wants the second; James, who
wants agents never to touch his screen, wants the third.

## Decision

**Desktop work runs in one mode the owner picks, per machine:
`computer.desktopMode` = `none` | `host` | `vm`.**

| Mode   | Where the work happens                                                                                      | Default                     |
| ------ | ----------------------------------------------------------------------------------------------------------- | --------------------------- |
| `none` | No desktop. Web work runs in Clankie's private headless browser. A hire that needs a native app is refused. | Yes, on every new install   |
| `host` | The owner's own Mac, in the background only, with his consent for this machine                              | Opt-in                      |
| `vm`   | A macOS guest on this Mac, booted with the Virtualization framework, with agent-desktop inside it           | Opt-in, needs the disk room |

**A hire asks for a desktop; Clankie routes it.** `start_agent` and
`hire_agent` take `desktop: true` when the work needs a screen. Clankie reads
the machine's mode and either:

- `none`: starts the hire without a desktop and tells it to use the private
  browser (`clankie browser`), or refuses with "this machine has no desktop
  for agents; the owner can turn one on with `clankie computer mode host|vm`"
  when the brief needs a native app;
- `host`: starts it with the background-only screen rule from #230 in its
  brief and a Codex computer-use or agent-desktop seat; anything that can only
  happen in front of the owner stops and goes to the lead;
- `vm`: starts the guest if it is stopped (headless, no window on the owner's
  screen), and starts the hire with its desktop tools pointed into the guest.
  Inside the guest the agent may front windows and use the mouse.

A hire that does not ask for a desktop never gets one, in any mode. The
machine's ADR 0244 screen ceiling still caps every mode: `host` needs the
screen ceiling on; `vm` does not use the owner's screen and only needs
`workers`.

**The setting lives in the CLI first and is Advanced.**
`clankie computer mode [none|host|vm] [--machine ID] --json` shows and sets it.
`clankie computer vm status|start|stop|create` manages the guest: `create`
says the image size and free disk and needs `--yes`, because it downloads
macOS and spends tens of gigabytes. `clankie doctor` reports the mode, and for
`vm` whether the guest exists, runs, and has agent-desktop and a browser
inside. The app shows the mode read-only on the machine's page and links to
the CLI. It goes in the [settings inventory](../settings-inventory.md) under
Advanced.

**Sign-ins go through a credential vault the model never reads.**
James set the condition: the private browser is fine only with a secure way to
store and pass credentials, the way Grok Bot and Muse do it. So:

- When an agent reaches a sign-in, it calls `request_credential` with the
  site's origin (for example `https://github.com`) and the field shape
  (username and password, or a one-time code). It never names or sees a value.
- Clankie shows the owner a small sign-in card on the surface he is using: the
  app's feed, the desktop pet or a Discord DM from the official bot to him.
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

## Consequences

- The screen takeover of 2026-11-01 has nowhere to happen by default: a new
  install has no desktop for agents at all, and `host` mode is background-only
  by rule and by brief.
- James's Mac goes to `vm` once a guest exists. The GitHub App form, and work
  like it, runs inside the guest with his GitHub sign-in made once through the
  vault card (and his 2FA code through the same card).
- New code: the `computer.desktopMode` setting and CLI, hire routing and the
  `desktop` hire flag, the guest manager over Tart or Lume (whichever the
  owner's Mac already has; Tart first otherwise), the vault card on the app,
  pet and Discord, the broker fill path and its audit log. Each lands with an
  E2E test against the real browser or guest (ADR 0221).
- The vault card is a new place a secret is typed. It inherits the doorway's
  encryption and the broker's Keychain storage, and adds an exact-origin check
  that the old "type it into chat" path never had.
- What this ADR does not do: no hosted desktop (ADR 0300), no shared desktop
  between owners, no automatic account creation (ADR 0127 still holds), and no
  driving the owner's foreground windows in any mode.
