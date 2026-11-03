# ADR 0344: Agents drive Herdr browser panes through Herdr's own commands

Status: Proposed, 2026-11-02, from James's direction the same day: turn on
agent control of Herdr browser panes ("On"), and "develop an agent ergonomic
way to control the herdr browsers that herdr devs would agree with". Builds on
[ADR 0342](0342-desktop-work-runs-in-the-mode-the-owner-picks.md) (desktop
modes and the sign-in vault) and keeps
[ADR 0139](0139-clankie-rides-vanilla-herdr.md)'s rule that Clankie reaches
Herdr through its CLI and socket, not a private patch of his own.
Amended by [ADR 0349](0349-playwright-reaches-agent-browser-panes-through-a-guarded-pipe.md):
`browser.cdp` adds one guarded loopback endpoint for Playwright on agent panes.

## Context

James runs a personal build of the Herdr desktop app, Herdr Browser
([Volpestyle/herdr-app](https://github.com/Volpestyle/herdr-app), branch
`james/native-browser`), that embeds Chromium (CEF) panes beside the agents. He
wants agents that need a browser to use a pane next to them, where he can
watch, and to fall back to a desktop (ADR 0342) only when a page is not enough.

Today an agent can open, navigate, reload and `browser.inspect` a pane through
the app's control socket (`herdr-browser do browser.open ...`). It cannot read
the page or press anything. The only way to do more is Chromium's remote
debugging port, which the fork leaves off unless `HERDR_BROWSER_DEBUG_PORT`
names one. That port is the wrong tool:

- Any program on the Mac that can reach `127.0.0.1` can drive every page in
  the browser, with every sign-in in its profile. It has no notion of panes,
  agents or who opened what.
- It sits beside Herdr instead of in it: no `herdr-browser do` command, no
  entry in the agent guide (`defaults/AGENTS.md`), nothing Herdr's maintainer
  would take upstream.

Herdr's own rules shape what it would accept. Its app core stays small and
everything else is mods, unless the app itself acts on the thing, only the app
can see it, and mods cannot do it even with care
([AGENTS.md](https://github.com/Volpestyle/herdr-app/blob/james/native-browser/AGENTS.md)).
A native page passes all three: the CEF view lives inside the app process and
no mod API reaches it. Its security note already sets the trust line: the app's
control socket lives in its home, and access to that home is access to the
window and its commands
([docs/security.md](https://github.com/Volpestyle/herdr-app/blob/james/native-browser/docs/security.md)).

## Decision

**Browser control is a small set of Herdr commands on the existing control
socket, aimed at one pane, carried in process. No network port.**

The app adds these commands beside `browser.open` and `browser.inspect`. Each
takes `pane`; called from inside a Herdr terminal without `pane`, it means the
browser pane that terminal opened most recently, never the focused one, so an
agent can never act on a page the person is looking at by accident.

| Command                                                 | Does                                       | Returns                                                                                |
| ------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------- |
| `browser.snapshot {pane, scope?}`                       | Reads the page's accessibility tree        | Compact text lines with refs (`e12 button "Sign in"`), URL, title, a generation number |
| `browser.read {pane, format?: "text" \| "markdown"}`    | Reads the page's visible text              | Text, capped, with the URL                                                             |
| `browser.click {pane, ref}`                             | Clicks an element from the latest snapshot | `ok`, the new URL if it navigated                                                      |
| `browser.type {pane, ref, text, submit?}`               | Puts text into a field                     | `ok`                                                                                   |
| `browser.press {pane, key}`                             | Sends one key or chord to the page         | `ok`                                                                                   |
| `browser.scroll {pane, ref? \| dy}`                     | Scrolls an element into view, or the page  | `ok`                                                                                   |
| `browser.wait {pane, text? \| url? \| load?, timeout?}` | Waits for a page condition                 | `ok` or `timeout`                                                                      |
| `browser.screenshot {pane}`                             | Captures the page, not the screen          | A PNG path in the app home                                                             |

How it works and why Herdr's maintainer should agree:

- **In process.** The app calls Chromium's DevTools protocol through CEF's
  in-process API (`CefBrowserHost::ExecuteDevToolsMethod` with a message
  observer) on that pane's browser only. No port is opened, and
  `HERDR_BROWSER_DEBUG_PORT` stays a developer switch.
- **Background-safe.** Clicks and keys go to the page as DevTools input events.
  They never move the pointer, focus the window or bring Herdr to the front,
  so an agent can work in a pane while the person types elsewhere.
- **Refs, not coordinates.** `browser.snapshot` hands out short refs tied to
  its generation. A ref from an older generation (the page navigated or
  changed) is refused with "snapshot again", the same pattern agent-browser and
  Playwright's MCP use, so agents never click on stale guesses.
- **Same trust as today.** The control socket already lets whoever can reach
  the app home open panes, run terminals and close them. These commands add
  page reading and input on that same line, documented in `docs/security.md`.
- **Agent guide and help.** Every command goes into `defaults/AGENTS.md` and
  `src/SKILL.md` in the same change, as Herdr's rules require.

**An agent profile, separate from the person's.** `browser.open` takes
`profile: "agent"` (default `"person"`). An agent profile is its own Chromium
request context with its own cookies and storage under the app home, so an
agent works signed out of the person's accounts unless a sign-in is made there
on purpose, through the ADR 0342 vault card. Commands that read or press
refuse a `"person"` pane unless the caller passes `confirmed: true`. That is a
guard against an agent wandering into the person's signed-in pages by mistake,
not a security boundary: Clankie's workers pass it only when the owner asked
for that page in that task.

**Clankie's side stays vanilla.** Clankie does not wrap these commands. A
worker in Herdr Browser sees `$HERDR_BROWSER`, opens a pane beside itself with
`herdr-browser do browser.open --profile agent --place right --pane <its pane>`
and drives it with the commands above. The hire brief and the
`desktop-control` and `browser-use` skills say the order: a Herdr browser pane
when the workspace has one, Clankie's private browser when it doesn't, a
desktop (ADR 0342) only for native apps, never the person's own Chrome or
screen. `clankie doctor` reports whether the machine's Herdr has browser panes
and these commands. When the stock Herdr app (or another workspace such as
Orca) ships its own browser, workers use its commands the same way, found by
capability, not by name.

**Sign-ins stay in the vault.** `browser.type` refuses a password field. A
sign-in in a browser pane goes through the ADR 0342 card, whose fill reaches
the field through the same in-process DevTools call and never the agent.

## What any other local program could still do

The control socket is a file in James's app home, readable by programs running
as him. Any such program can already open panes and terminals there; with this
ADR it can also read and press in agent-profile panes, and in person-profile
panes with `confirmed: true`. It cannot do so over the network, cannot reach
the browser from another user account, and gets nothing from Chromium's
debugging port, which stays closed. A future Herdr change could add a
per-terminal token to the socket; this ADR does not depend on it.

## Consequences

- James's fork gets the commands first, built and tested on his Mac in a
  worker that never touches his screen. Installing the new build needs his yes,
  like the 0.1.11 swap.
- A short proposal goes to Herdr's maintainer only after James reads it, as
  part of the "native browser host API" question the fork already asks
  upstream (`personal/COMMUNITY.md`).
- The hire brief, the two skills and `clankie doctor` change in Clankie; the
  E2E test drives a real Herdr Browser pane on the Mac (ADR 0221).
- PCs: the CEF browser is macOS-only today, so Windows workers keep Clankie's
  private browser until Herdr has a browser there.
