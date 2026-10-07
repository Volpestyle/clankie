# Machines and Herdr workspaces

Machines and devices, which Herdr session Clankie uses and how to change it, messages to external Codex sessions, and delivery receipt stages.

## Machines and devices

Machines run agents; devices are paired portals. Use `clankie machines --json`
for configured machines and discovered candidates. `machines discover --json`
refreshes bounded, non-prompting SSH discovery. An unreachable candidate remains
listed; no probe starts Herdr or installs software.

`machines add NAME --ssh HOST [--shell posix|powershell]` immediately registers
transcript reading and offers existing Herdr sessions. `machines sessions NAME`
lists them; add `--connect SESSION --id CONNECTION` to connect one. Named
connections apply live. `machines remove NAME` detaches its connections without
stopping workers. Historical connection IDs, transcript references and grants
keep their meaning. `herdr add/remove/fleets`, `runtime connect` and `agents hosts`
remain aliases. Only a changed default workspace needs `clankie restart captain`.

The console's `/machines` lists discovered machines and their Herdr sessions
before asking for typed names. Named connections apply live. Its session details
manage workspace grants and capacity; choose native harnesses per hire. The
`/herdr` default workspace choice still requires a restart. `/setup rooms` offers that
choice only after doctor finds installed Herdr with running sessions, explaining
that leading the owner's session means seeing and messaging every pane.

## Worker defaults

`clankie fleet set --harness codex --model gpt-6.1-sol --effort xhigh` updates
fleet worker defaults one field at a time. Use `auto` for a field to remove its
default and let Clankie choose per job; project roles take the same `auto`
(`clankie agents role ROLE --project P --harness auto --model auto --effort auto`).
With no harness at any layer, Clankie picks Claude or Codex for each hire; a hire
that still names none falls back to the machine's usable, unheld accounts (the
only harness with one, else Codex above half its usage, else Claude) and never
to a fixed harness. Other hire-profile fields and fleet
resource settings are preserved. `--hire-profile FILE.json` replaces the whole
profile; use it separately from these flags. Explicit hire choices override
project roles, which override fleet defaults. New hires use the result; existing
lanes stay as they are. `clankie fleet status` reports stored defaults and
effective role profiles; TUI `/fleet` edits them and `/fleet status` (also `/fleet show`) prints
`worker defaults: …`. `fleet clear` clears them too.

## Herdr runtime

The TUI `/status` shows the live binding. In the TUI, `/herdr` opens the
**Use an existing Herdr session** / **Create a session for Clankie** menu. Save, and
choose **Restart now** to apply it without leaving the TUI, or **Later** to leave
it pending. The menu shows both configured and active bindings, and after a
restart it warns when the saved session did not answer. Bundled panes start
the owner's login shell with the owner's environment restored; the private
XDG roots that isolate that Herdr never reach an agent.

The binding is resolved fresh at every service start and never written back
(ADR 0181): the explicitly named session, else Clankie's own Herdr session.
The invoking terminal never selects the fleet. A candidate that does not answer is stepped
over. If his own runtime cannot start, he continues with Herdr unavailable.
`clankie herdr disable` (or **Run without Herdr** in `/herdr`) selects no execution
runtime; restart to apply it. Conversations and native communication still work.
`use NAME` or `create` and a restart enable Herdr again. His own session checks
official stable releases at startup and every six hours. Verified updates stage
without replacing a live fleet's executable; the next Clankie start without a
live owned server applies them. `pnpm herdr:build` prepares the official offline
fallback in a checkout. `clankie herdr status --json` distinguishes the
configured choice from the running `active` binding. Change it with
`use NAME`, `create`, or the compatibility command `set --runtime auto`
(the bundled default), then `clankie restart captain`.
`set --runtime external` keeps whichever session name is already saved.

`clankie herdr`, `clankie-herdr`, `clankie herdr open`, and TUI `/herdr open` attach to the
running local fleet; Ctrl+B then Q detaches without stopping workers. Every
TUI's roster, jumps, and optional board follow the service's binding. Source
socket identity qualifies pane-scoped messages and worker stances.

External mode leaves server lifecycle to its owner. A connection lost during a run
stays unavailable until restart; no replacement fleet is silently created.
`/health` reports disabled, unavailable or recovering execution independently of
service liveness. `/v1/herdr` returns 503 without an active binding.
Doctor's `commands.herdr` probes the selected CLI. `commands.herdr-lead` and
`herdrPlugin` describe the optional dashboard integration.
Load `lead` for native hiring, messaging and harvest; Herdr is the inspection/runtime surface. The optional dashboard CLI is installed separately. Never run `herdr-lead`
bare or with `--version` — that starts a TUI and hangs the shell. `herdr-lead
state` and `herdr-lead split` are the headless verbs. If the plugin is
bundled and not linked, doctor's `remediations` already has the link command.

Clean up temporary worker panes you create once their results are saved and
verified. Keep ownership in the existing brief, check the pane still holds your
finished worker, then `herdr pane close ID` and verify it is gone. Keep panes
needed for follow-up or requested by your person; leave borrowed or repurposed
panes and operator drafts alone. Your own finished-worker cleanup is already
authorized.

## Messages to external Codex sessions

`message_seat` first tries the existing Codex app-server proxy on the selected
local or linked machine, using the pane's exact session and active turn. A
`state: steered` receipt confirms that turn accepted it. A queue receipt has
`state: queued`, `status: queued_until_turn_end`, and an explicit detail: it waits
until the turn ends, potentially the entire goal. Do not interpret it as seen.
An unconfirmed steer must be reconciled before retrying; never type a fallback
into the pane. Owner approval/input remains pending.

A shared daemon still may lack a valid Herdr pane/session report. Do not guess a
thread from recent history, globally enable the daemon, or forge membership to
repair it. Outbound owner-authorized control does not authorize inbound fleet
MCP tools: shared-daemon local MCP membership continues to fail closed. Private
`--no-daemon` sessions generally have no externally reachable control socket.

## Delivery receipt stages

Read `deliveryStage` separately from the native outcome and work status:
`stored` is service retention, `delivered` is bridge receipt, `consumed` is native
queue/turn acceptance, and `responded` is a correlated response or turn outcome.
Native queues count as consumed even while waiting for an active turn or goal;
this never means model-seen or completed work. `unavailable`, `expired`, and
`rejected` say where delivery stopped. `uncertain` blocks every retry and every
fallback until the original receipt is reconciled, including after restart.

Keep the native queue/steer state and detail when reporting to the owner.

For inbound `message_clankie`, `stored` is retained conversation acceptance,
not proof Clankie read it or completed work. Both `mcp --seat` and `mcp --fleet`
retain the original ID, native binding and payload through bridge replacement.
After `uncertain`, another call only reads that original receipt. Do not change
text, generate a new ID, switch bridges, or remove receipt files to retry.
Different follow-ups remain unsent while resolving the original; missing,
revoked or corrupt evidence stays blocked. No-ID legacy writes are rejected.
