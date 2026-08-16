# apps/tui/bin/service-supervisor.ts

Generic supervision for launcher-owned local
processes: `inspectService`, `startService`,
`stopService`, `restartService` over a declarative
`ManagedService` (spawn args, health probe,
`commandMatches` ownership guard, optional
`serviceEnv`, `enabled`, `restartsWith`). Also the
state-path helpers (`clankieStateDirectory`,
`serviceStatePath`, `serviceLogPath`) and process
utilities (`processIsAlive`, `readProcessCommand`,
`listProcessCommands`, `findServiceProcessPids`).

Rules, each earned by a real failure:

- Atomic mode-0600 pid record per service under
  `${XDG_STATE_HOME:-~/.local/state}/clankie/`.
- Before any signal the recorded pid's live `ps`
  command must still match the service
  (`assertOwnedPid`) — recycled pids are never
  killed.
- Start is health-gated: returns only when the probe
  answers healthy (default 60s), detaching and
  unref'ing the child; spawn errors and early exits
  clear the record and point at the log file.
- Stop escalates SIGTERM → SIGKILL (process group
  first) with grace windows.
- Liveness questions ask the process table, not
  published state: the Discord bridge's durable
  `present` phase outlives a dead bridge, and an
  unhealthy end-to-end tunnel probe (edge 530) must
  not be read as "port occupied" — both misreads
  wedged real restarts.
- Foreign healthy processes are reported, never
  killed; a foreign unhealthy occupier blocks start
  with an explicit error.

`SERVICE_ORDER` = clankie, discord-bridge, activity,
tunnel (dependency order).
