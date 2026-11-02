# ADR 0341: Codex hires run in the desktop app's terminals

Status: Accepted, 2026-11-02. Extends
[ADR 0319](0319-hires-run-in-the-desktop-apps-terminals.md) to Codex. Closes
#240: on a Mac whose hires are pinned to the desktop app (`--seat-host desktop`)
and which runs no Herdr TUI server, a Codex hire still went to a Herdr pane and
timed out waiting for its agent to start.

## Context

ADR 0319 moved new Claude hires into the Herdr desktop app's own terminals and
left every other harness in Herdr panes. The owner now runs only the desktop
app, so a Codex hire had nowhere to start, and Codex is the harness the owner
wants used for new work where it fits.

A Codex hire differs from a Claude hire in two ways that matter here:

- Its session is a thread its view creates or restores once it is running, so
  it can't be named on the command line the way Claude's `--session-id` is.
- Its tools run under the app-server Clankie starts for the hire (the view
  attaches with `--remote`), not under the process in the terminal. In a Herdr
  pane that server is admitted through Clankie's private registration of it,
  never through the pane's process tree.

## Decision

With `--seat-host desktop`, new Codex hires start in the desktop app's
terminals too. Prepared launches and other harnesses still use Herdr panes.

- **Launch.** The terminal's launcher execs the installed `codex` in its place,
  as it does `claude`, with the view's arguments. No session is read from
  Codex's arguments.
- **Thread.** The Codex adapter reports its thread and turns for a
  `herdr-core/` pane to the desktop runner instead of `herdr pane
report-agent`. The runner accepts a report only for the harness it started in
  that live terminal, labels the terminal with the thread once, and writes the
  private seat record (the terminal's pid, `codex`, the thread) that the seat's
  proof trusts. A report naming a different thread is refused. The view's end
  is read from the runner, not Herdr's event feed.
- **Tools.** The app-server is registered against the terminal's
  `herdr-core/<address>` pane and the core's socket, and its worker bridge
  names that pane and socket. Its project proof is the one a Herdr pane's Codex
  seat gets: the view by its seat proof (Clankie's record, the installed
  launcher), the server by its registration and the thread it bound. Claude
  hires in the desktop app keep their direct proof unchanged.
- **Memory only.** A desktop terminal's server registration is never written
  to `local-codex-seats.json`, which the Herdr-pane recovery, census and
  retirement paths read, so none of them acts on a terminal it can't see.
  After a service restart such a hire's tools are no longer admitted through
  its old server, and a rehire binds a new one.

## Consequences

- On a desktop-only Mac, Codex hires start, are seated under their thread and
  can be messaged, read and closed like Claude hires there.
- A Codex desktop hire does not survive a service restart with its tools; its
  terminal stays up for the owner, and it can be rehired.
- Herdr panes are unchanged for every harness.

## Amendment: each Codex hire selects its checkout (#252)

A terminal's cwd does not select the native thread's cwd when Codex uses an
app-server. In particular, a hire without a brief skips Clankie's dedicated
app-server adapter and launches plain Codex, which may use the shared daemon.
Both that launch and the dedicated adapter's remote TUI launch now pass `--cd`
with the prepared hire checkout explicitly. Claude continues to run from its
terminal's own cwd.

Before reporting a Codex hire started, Clankie checks the pane's observed cwd
against the prepared directory; missing or different observations leave startup
unconfirmed. The dedicated adapter also checks `thread/read`'s cwd before
binding or sending any brief. A thread mismatch fails startup without a brief.
No process-wide cwd change or shared app-server restart is needed. This applies
to new hires after the updated service loads; existing threads keep their cwd.
