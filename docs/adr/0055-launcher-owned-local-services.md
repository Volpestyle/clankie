# ADR 0055: The launcher owns every local service

Status: accepted (James, 2026-07-25). Applies to the single-service pi
architecture.

## Context

Clankie is present through several long-lived local processes. Starting them by
hand leaves no durable ownership record, no dependency-aware restart, and no
reliable health gate.

## Decision

`apps/tui/bin/service-supervisor.ts` owns the process mechanics and
`apps/tui/bin/services.ts` declares the services and their dependency order.
The backend is one `clankie` process: the HTTP API, pi captain, presence state,
media, and game bodies all live there. The Discord bridge depends on it. The
optional lab user-session body depends on it too and stays off until enabled
([ADR 0098 (user-session shares)](0098-user-session-watches-discord-shares.md)). The activity
surface and tunnel publish what he plays.

Every managed process gets:

1. an atomically written mode-0600 pid record under the Clankie state root;
2. a live command check before any signal, so a recycled pid cannot kill an
   unrelated process; and
3. a service-specific health gate before start succeeds.

Unowned conflicts are scoped to the resource the service uses: the configured
TCP port for Clankie, relay and activity, or the configured activity tunnel
name. A process command identifies the kind of service but cannot distinguish
instances whose ports and state roots travel in environment variables.
`lsof` supplies address-independent listener evidence; a bind probe cannot
reliably detect wildcard versus loopback conflicts on macOS. Failed inspection
falls back to the conservative command scan. Discord bodies keep the command
scan because a separate local port does not establish a separate Discord identity.
Health probes and the live-command check before signalling retain their own roles.

The force-kill deadline is also service-specific. Generic services retain the
launcher's ten-second grace. Clankie's outer grace is its configured play
shutdown deadline plus two seconds, leaving its play host time to finish a
normal summary or publish the bounded forced terminal report before the
supervisor escalates to `SIGKILL`.

Restart follows dependencies. Restarting `clankie` also restarts the bridge
and the lab user-session body, because both hold live claims against the
service instance. Stopping one named service remains scoped to that service.

A restart requested from Clankie's own operator-turn bash tool is handed to a
detached launcher helper. Pi already exposes the durable `PI_SESSION_FILE`; the
launcher uses its conversation's append-only event log to wait for that turn's
terminal event before stopping the service. The operator face retries only a
dropped durable tail read, then resumes from its persisted cursor. It never
replays the prompt or any tools that already ran.

The compatibility aliases `captain`, `captain-eve`, `eve`, `control-plane`, and
`cp` all resolve to `clankie`; they do not name separate processes.

## Consequences

- `clankie restart` and `clankie status` cover the full local stack. The
  headless command contract is [`docs/cli.md`](../cli.md).
- A self-restart finishes the conversation turn before replacing its backend;
  a dropped tail reconnects without repeating the turn.
- A process started outside the launcher is reported but never adopted or
  killed.
- Restarting during play preserves terminal accounting instead of leaving the
  next process to infer an avoidable lease lapse.
- Settings remain the source of Discord allowlists; the launcher supplies only
  repository paths and brokered service credentials.

## Amendment: crashed services come back, 2026-10-06

On 2026-10-06 at 23:51Z an unhandled socket `error` from the IMAP client exited
the clankie service (fixed separately). Nothing was resident to notice, so it
stayed down until the owner ran `clankie restart`; the service log held 264
earlier `Exit status 1` endings. James approved automatic recovery.

**Decision.** launchd wakes the launcher; the launcher still owns the
processes. The existing `bot.clankie.autostart` agent now runs
`clankie recover --autostart` at load and every 30 seconds (`StartInterval`,
still no `KeepAlive`). Each run is a short, fresh launcher process, so it
always runs the currently pinned code and leaves nothing resident to hang or to
outlive an update. Handing the services themselves to launchd `KeepAlive` was
rejected: it would bypass the pid records, live-command checks, health gates
and dependency-ordered restart above, and launchd would fight every deliberate
stop and update cutover.

- **Desired state is the pid record.** A start writes it and only a deliberate
  stop, or a start that died before it was healthy, removes it. A record whose
  pid is dead is a crash; a missing record is intent. Recovery restarts through
  the same dependency-ordered restart as `clankie restart`.
- **Never fights intent.** An accepted update mid-cutover (the existing
  `updateHoldingServices` check) skips the pass. `start`, `stop` and `restart`
  now share one `services.lock`; recovery never waits for it and skips a pass
  while any operation holds it, and a holder that died is taken over.
  `clankie autostart disable` turns recovery off.
- **Crash loops end.** Attempts within 30 minutes wait 0 s, 30 s, 2 min, then
  5 min; a restart that dies before it is healthy counts as another crash.
  Five crashes in 30 minutes leave the service stopped. A deliberate `start`,
  `stop` or `restart` clears the backoff and the give-up.
- **Why it died, and who is told.** Each crash keeps the tail of the service's
  log in `<service>-recovery.json` under the launcher state root. `status`
  (`recovery`) and `doctor` (`serviceRecovery`) show recent crashes and a
  give-up. The restarted clankie service tells the owner once through the
  runtime-health alert path (`CLANKIE_CRASH_REPORT` names the record; the
  service marks what it reported in a separate file the launcher never writes).
  A give-up raises one macOS notification, since the service that would send the
  alert is the one that is down; the alert follows when it next starts.
- **First run after a boot** starts Clankie as the one-shot login agent did, so
  `enable` keeps its old meaning. An agent written by an older install reads as
  `stale` until `enable` rewrites it.

Linux has no agent yet; a systemd user timer running `clankie recover` gives
the same behaviour.

Known limits: up to 30 seconds pass before a crash is noticed; the exit code of
a detached service is not observable, so the log tail stands in for it; a
logout that ends the session's processes is recovered and reported as a crash
at the next login tick; and a service that hangs without exiting is not
detected (that remains the runtime-health observer's job).
