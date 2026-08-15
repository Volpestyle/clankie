# apps/tui/src

The fullscreen operator face. `index.ts` wires the
ported v1 face shell to the clankie service: operator
conversation dispatch for plain prompts, slash
commands for everything else, pollers for the status
bar.

Children:

- `index.ts` — entry point and assembly.
- `commands.ts` — console commands (/help
  /conversation /trace /layout /clear /activity
  /status /exit).
- `provider-commands.ts` — /auth /provider /model
  /effort wizards plus positional /image-model and
  /video-model.
- `discord-commands.ts` — /discord wizard (tokens to
  the broker, ids/allowlists to settings.json).
- `persona-commands.ts` — /persona (character, names,
  chattiness — never authority).
- `voice-commands.ts` — /voice (OpenAI realtime vs
  ElevenLabs TTS).
- `activity-command.ts` — /activity formatter for the
  current-activity projection.
- `face/` — ported v1 rendering components (fix bugs
  upstream-style, don't restyle).
- `shell/` — the shell that assembles them: input
  router, SetupFlow wizard engine, status bar, theme.
- `session/` — conversation client, renderer, lane
  observation, trace renderer + cursors.
- `observation/` — presence poller and Herdr pane
  roster.

Commands are `FaceShellCommand`s; configurators run
as guided SetupFlow modals; results land as
`done /cmd command` transcript blocks. Secrets go
only through the credential broker and render only
redacted.
