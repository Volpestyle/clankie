# ADR 0319: Hires run in the Herdr desktop app's terminals

Status: Proposed, 2026-11-01. James asked for it on 2026-10-31 ("lets use
desktop app for workers now"). Amends [ADR 0187](0187-clankie-hires-his-own-seats.md)
and [ADR 0301](0301-claude-reaches-the-fleet-through-a-narrow-connector.md).

## Context

Every hire opens a pane in the terminal Herdr and starts its harness there with
`herdr agent start`. The owner now works in the Herdr desktop app, whose
terminals belong to its own terminal server, herdr-core (`hc`). Clankie already
lists and reads those terminals (ADR 0301,
[ADR 0307](0307-a-connector-reads-only-a-live-agents-own-output.md)), but a hire can't start in
one, so his workers live in a window the owner no longer looks at.

herdr-core starts a terminal with one call, `terminal.run { argv, cwd, env,
labels, on, keep }`, and answers with its address (`t7`, or `pc/t7` on a
machine reached over SSH). The window shows a terminal labeled
`herdr.space=<id>`, in the tab named by `herdr.tab=<id>`; unlabeled terminals
stay hidden. `keep: true` keeps a terminal across a window close and a core
restart, at the same address. `terminal.get` and `events.subscribe` report its
state, foreground process, exit and the agent status it reports;
`terminal.read` reads its screen; `terminal.kill` ends it. The child gets
`HC_TERMINAL_ID` and the core's socket. Input goes only through
`terminal.attach`, which is typing.

Clankie's seat code is shaped around Herdr panes. A seat's id is Herdr's
terminal id (`term_…`), its view is a `w1:p2` pane, the worker plugin finds its
service link and scopes its receipts by `HERDR_SOCKET_PATH` and
`HERDR_PANE_ID`, and a Claude seat binds once Herdr reports the session it
detected.

## Decision

- **A machine's hires go where its owner works.** When the desktop app's core
  answers on a machine, Clankie's hires there start in its terminals; otherwise
  they start in Herdr panes as today. `clankie fleet set --seat-host
auto|desktop|herdr` pins it per machine for the rare owner who wants the
  other; there is no Common setting. Hires already running stay where they
  are. Until the desktop app's hires are proven on the owner's Mac, `auto`
  keeps them in Herdr panes and `desktop` opts in.
- **Each project gets a space, each hire its own tab.** Each hire is a
  `terminal.run` with `labels { herdr.space: "clankie-<project>", herdr.tab:
<a fresh id>, clankie.seat: <hire> }` and `keep: true`, started in the hire's
  checkout with its harness command as `argv`. The window treats both labels as
  ids and makes an unnamed space or tab for a new one (shown by a folder and a
  number), so the terminal also carries the names it should show
  (`clankie.space-name` = `<project> workers`, `clankie.tab-name` = the hire's
  name and task), and Clankie renames them through `herdr-app do space.rename`
  / `tab.rename` once an open window places the terminal. Only an automatic
  name is replaced, never one the owner chose. A project's pipeline hires share
  a tab three at a time, then open its next (`review · 2`). The first version
  put every hire in one `clankie` space under its display label as the tab id;
  hires shared that label, so they landed as narrow panes of one tab.
- **A seat's id is its core address.** Locally that is `herdr-core/t7`, routed
  like a fleet-qualified pane under the reserved `herdr-core` prefix that no
  execution connection may take; for a machine the core reaches over SSH,
  `herdr-core/pc/t7`. Pane ids, receipts,
  the mailbox, the census and the connector use it wherever they use a Herdr
  terminal id today. The core address is never typed into a Herdr call.
- **Clankie names the session, not the terminal.** A Claude hire launches with
  `--session-id <uuid>` that Clankie chose, so the seat binds at launch instead
  of waiting for a detector. Harnesses without a chosen-session flag bind
  through their own control channel (the Codex app-server thread, for one).
- **The worker knows its seat from the core.** When `HERDR_PANE_ID` is absent
  and `HC_TERMINAL_ID` is set, the worker plugin scopes receipts and presence
  by the core socket and terminal, finds its link by the core socket, and sends
  `herdr-core/<address>` wherever it would send its pane id (the
  `x-clankie-pane` header included). The service proves that process against
  the core's own record of the terminal before it admits the seat.
- **The core reports life and death.** Finished, lost and removed events end
  or park the seat as a closed pane does now; status and turn events stand in
  for Herdr's agent status; `terminal.read` backs `terminal_read`.
  `terminal.kill` closes a seat after the usual parking, and `terminal.rm`
  then takes its ended terminal out of the window, which the core otherwise
  keeps (#584). Auto-tidy lists the desktop app's hires beside Herdr's, and
  removes a finished terminal of a hire Clankie recorded (by its seat and
  session) once it has sat ended for the auto-tidy window; the owner's own
  terminals are never removed. Until then `list_agents` lists it as
  `finished`, with who started it. A desktop hire's owner record names its
  session as this machine's (`local`), as the hire binds it before the router
  places it, and every lookup reads it that way. Nothing is ever sent
  through `terminal.attach`: messages reach a worker through its channel, as
  [ADR 0207](0207-work-records-and-native-agent-delivery.md) requires.
- **Mac first, then the PCs through the core.** The first step places Mac
  hires only. The PCs follow as the core's own machines (`on: "pc"`), so the
  Mac's core runs them over SSH and the window shows them beside the Mac's.
  `clankie herdr prepare` keeps staging each machine's worker files and
  harness setup.

## Consequences

- A seat host for herdr-core sits beside the Herdr runner under
  `routeHerdrFleets`. A prepared launch's command is the terminal's program. A
  harness that starts through `herdr agent start` (Claude) starts its terminal
  at a small launcher instead: the core takes no command after a terminal
  starts, and nothing types into it, so the service writes the harness command
  to a private file the launcher sources, and the harness execs in the
  launcher's place. Its seat proof is then the terminal's own process.
- Anything inside a terminal can relabel it through the core's socket, so a
  seat's project proof trusts Clankie's private record of what he started (the
  terminal's pid when the harness took it, and the session he named) rather
  than its labels. The socket owner's ancestry must hold that pid, and the
  kernel must show it running the installed harness. Under the worker sandbox,
  the launcher starts inside the worker's Seatbelt profile, since a terminal
  runs no shell to apply it.
- The `w<n>:p<n>` checks scattered through proofs, the mailbox, connector
  routes and the worker bin accept a core address where a seat id is expected.
  Machine-access ceilings
  ([ADR 0244](0244-machines-join-clankie-at-an-access-level.md)) and project policy apply unchanged.
- ADR 0301's "can't be messaged" note ends for Clankie's own hires: they carry
  the worker channel. Terminals the owner starts by hand still can't be
  messaged. The census reads the core as one more fleet (`herdr-core`), from
  the terminals Clankie started and named a session for, so his hires are fleet
  seats beside Herdr panes, and their seat control uses this machine's harness
  adapters. The core's own list leaves those out, so a hire shows once.
- Steps: this ADR; the Mac host and Claude prepared launch; worker identity
  from the core; Codex; the PCs through `on`. Each step lands on its own and
  leaves the Herdr path working.
- To confirm on the Mac before the host lands: the core's socket and `hc
--skill`, how a run's `env` merges with the core's, and whether events stream
  on the line socket.

## Amendment, 2026-11-03 (#291)

The core can only override a variable for a terminal, never unset it, and clearing
the inherited Herdr variables to empty strings broke the stock `herdr` CLI in every
desktop hire. A hire's terminal now gets Clankie's own Herdr session socket as
`HERDR_SOCKET_PATH`, so the CLI there reaches his Herdr, while `HERDR_PANE_ID` and
the rest stay empty. A seat is named by a Herdr pane id when there is one, else by
the core terminal (`HC_TERMINAL_ID` beside `HC_TERMINAL_SOCKET`); a Herdr socket
without a pane id no longer names a seat. The worker's link, the CLI's seat identity
and the tool-catalog hook read it the same way.

## Amendment, 2026-11-03: the owner's terminal catalog lists them

The phone's Terminals tab read only the terminal Herdr's panes, so the desktop
app's terminals, where Clankie's hires now run, never appeared there.
`terminal_catalog` now also lists every live terminal in the desktop app's window,
from the layout the app keeps in the core's `herdr-app` document: its spaces,
tabs and terminals as workspaces, tabs and panes, in the app's order, under the
runtime `herdr-core` ("Herdr app"). The app saves that document only now and then,
so a terminal it has adopted since (labeled `herdr.space`/`herdr.tab`) is placed
by its labels, after the tabs the document knows. A space or tab is named as the app names it
(its own name, else the space part of the terminal's `where` label, else its
folder; a tab's name, else its place). A pane is named by the seat Clankie gave
it (`clankie.seat`), else its title, else its program and folder, never a bare
id. Its id is its seat id, `herdr-core/<address>`, so `terminal_read` reads it
under the read scope as before (ADR 0307).

`terminal_tail` watches one through a framed `terminal.attach` with `observe`:
the core's first paint, with up to 1,000 lines of history, is the stream's full
frame and its output the diffs. `terminal_focus` asks `herdr-app` to show it.
There is no control lease or input for these terminals: `terminal_control` and
`terminal_input` answer `herdr_unavailable` (ADR 0207). Terminals of another
machine the core added are not listed yet.

The desktop app's terminals are the owner's to watch. A connector app (ADR 0301)
never sees them in the catalog and is refused a tail of one at the relay; it
reaches the agents there as before, through `herdr_core_list` and
`terminal_read`. Herdr panes with no name of their own are now labeled by their
title, else by what runs in them and where, instead of their pane id.
