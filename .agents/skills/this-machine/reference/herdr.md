# Herdr runtime

Which Herdr session Clankie uses and how to change it.

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
runtime; restart to apply it. Conversations and Swarm communication still work.
`use NAME` or `create` and a restart enable Herdr again. His own session checks
official stable releases at startup and every six hours. Verified updates stage
without replacing a live fleet's executable; the next Clankie start without a
live owned server applies them. `pnpm herdr:build` prepares the official offline
fallback in a checkout. `clankie herdr status` distinguishes the
configured choice from the running `active` binding. Change it with
`use NAME`, `create`, or the compatibility command `set --runtime auto`
(the bundled default), then `clankie restart captain`.
`set --runtime external` keeps whichever session name is already saved.

`clankie-herdr`, `clankie herdr open`, and TUI `/herdr open` attach to the
running local fleet; Ctrl+B then Q detaches without stopping workers. Every
TUI's roster, jumps, and optional board follow the service's binding. Source
socket identity qualifies pane-scoped messages and worker stances.

External mode leaves server lifecycle to its owner. A connection lost during a run
stays unavailable until restart; no replacement fleet is silently created.
`/health` reports disabled, unavailable or recovering execution independently of
service liveness. `/v1/herdr` returns 503 without an active binding.
Doctor's `commands.herdr` probes the selected CLI. `commands.herdr-lead` and
`herdrPlugin` describe the optional dashboard integration.
Load `lead` for the Herdr fallback. The optional dashboard CLI is installed separately. Never run `herdr-lead`
bare or with `--version` — that starts a TUI and hangs the shell. `herdr-lead
state` and `herdr-lead split` are the headless verbs. If the plugin is
bundled and not linked, doctor's `remediations` already has the link command.

Clean up temporary worker panes you create once their results are saved and
verified. Record ownership in the handoff, check the pane still holds your
finished worker, then `herdr pane close ID` and verify it is gone. Keep panes
needed for follow-up or requested by your person; leave borrowed or repurposed
panes and operator drafts alone. Your own finished-worker cleanup is already
authorized.

Voice model selection preserves the configured voice ID and providers. Explicit
`eleven_v4_turbo` uses Text to Dialogue WebSockets; an unset model retains Flash
v2.5. `voice status` reports stored/effective settings and environment overrides.
`voice model clear` restores an originally unset model; restore any explicit
previous model with `voice model set ID`. The launcher does not restart for these
writes. When authorized, `clankie restart clankie` reloads the service and its
dependent bodies. Older installations have only the console `/voice` wizard.
A readiness check skips paid ElevenLabs synthesis: separate offline tests, real
provider audio, and actual Discord audibility when reporting verification.
