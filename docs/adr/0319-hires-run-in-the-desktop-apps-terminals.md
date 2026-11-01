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
- **They show in one Clankie space.** Each hire is a `terminal.run` with
  `labels { herdr.space: "clankie", herdr.tab: <hire>, clankie.seat: <hire> }`
  and `keep: true`, started in the hire's checkout with its harness command as
  `argv`. Clankie names the space once through the app socket
  (`space.rename`). A project's pipeline tab, when it has one, is the
  `herdr.tab`.
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
  `terminal.kill` closes a seat after the usual parking. Nothing is ever sent
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
- The `w<n>:p<n>` checks scattered through proofs, the mailbox, connector
  routes and the worker bin accept a core address where a seat id is expected.
  Machine-access ceilings
  ([ADR 0244](0244-machines-join-clankie-at-an-access-level.md)) and project policy apply unchanged.
- ADR 0301's "can't be messaged" note ends for Clankie's own hires: they carry
  the worker channel. Terminals the owner starts by hand still can't be
  messaged.
- Steps: this ADR; the Mac host and Claude prepared launch; worker identity
  from the core; Codex; the PCs through `on`. Each step lands on its own and
  leaves the Herdr path working.
- To confirm on the Mac before the host lands: the core's socket and `hc
--skill`, how a run's `env` merges with the core's, and whether events stream
  on the line socket.
