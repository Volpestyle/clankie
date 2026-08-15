# apps/tui/src/commands.ts

`buildConsoleCommands(context)` — the core console
slash commands, each a `FaceShellCommand` whose
result lands as a `done /cmd command` transcript
block:

- `/help` — command list plus key hints.
- `/conversation` (`/chat`) — list the server-owned
  registry or select one by id.
- `/trace` — list captain lanes, watch one/`all` via
  the `CaptainLaneTraceController`, or `off`.
- `/layout` (`/header`, `/banner`) — input/status
  placement, header visibility, spinner selection and
  cycle rate.
- `/clear`, `/exit`.
- `/activity` (`/watch`) — the authenticated
  current-activity projection plus the loopback watch
  URL.
- `/status` — presence phase, selected conversation,
  activity availability, and (inside Herdr) the
  sibling worker roster.

The `ConsoleCommandContext` keeps every dependency
optional so the shell assembles without a credential;
missing ports render explicit "unavailable" errors.
`runLayoutCommand` does the `/layout` argument
parsing against `face-settings.ts` and the spinner
catalog.
