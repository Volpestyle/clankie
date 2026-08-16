# apps/tui

The operator console: the `clankie` launcher plus a
fullscreen terminal face (ported verbatim from the v1
clankie TUI) that talks to the single clankie service
on port 4310. Plain prompts ride the server-owned
operator conversation dispatch; slash commands
configure providers, Discord, persona, and voice; the
launcher also supervises every long-lived local
service.

Children:

- `README.md` — full operator/architecture doc.
- `package.json` — `@clankie/tui`; bin `clankie`.
- `tsconfig.json` — typecheck-only config.
- `bin/` — the `clankie` CLI: launcher, service
  supervisor/registry, headless commands (status,
  restart, down, trace, pair, devices, play).
- `src/` — the fullscreen face: entry point, slash
  commands, face components, shell, session clients,
  pollers.
- `test/` — vitest suites for every layer.

Flow: `bin/clankie.ts` fills env from settings,
brokers credentials, health-gates the clankie service
up, then either runs a headless subcommand or imports
`src/index.ts`, which assembles `ClankieFaceShell`
with the command set and the operator-conversation
prompt session. No local scheduler and no state
inference from terminal text; everything durable is
server-owned, with per-surface replay cursors under
`.data/tui/` (mode 0600, fail-closed). Runs under
Node's native type stripping — the whole graph stays
erasable TypeScript, no build step.
