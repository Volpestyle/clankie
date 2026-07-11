# Clankie operator console (`@sapling/tui`)

The operator console wears the v1 clankie face: a fullscreen `@earendil-works/pi-tui` layout (differential renderer, scrollback preserved) with the banner, transcript viewport, status bar, slash-command typeahead, Ctrl+/ command workbench, guided modal flows, and the agent-spinners loader — ported verbatim from clankie snapshot `04734df9` (VUH-755).

The TUI is an Eve session client for captain conversation and a semantic
control-plane client for authoritative mission data. It must not become a
second scheduler or infer task state by scraping terminal text; `arch:check`
forbids importing `@sapling/mission-engine`.

Run after installing with Node 24 (requires a TTY):

```bash
clankie                        # via the bin/clankie.ts launcher (~/.local/bin symlink)
pnpm --filter @sapling/tui dev # from the repo
```

`clankie` attaches to a healthy captain at `SAPLING_CAPTAIN_URL` (default
`http://127.0.0.1:4321`) or starts one shared `eve dev --no-ui` process. Captain
logs stay out of the fullscreen terminal at
`${XDG_STATE_HOME:-~/.local/state}/clankie/captain-eve.log`. The service remains
available when one TUI face exits, so sibling Herdr panes do not disconnect one
another. Direct `pnpm --filter @sapling/tui dev` expects the captain service to
be started separately.

The same executable has a non-interactive `--recovery-probe` mode for the M1
crash/reconnect gate. It reads mission state through `@sapling/api-client`,
consumes sequenced terminal replay from the runner's semantic boundary, writes
an atomic cursor checkpoint, and remains alive so the drill can crash the real
TUI process. This is a CI proof surface, not an alternate operator interface.

The `clankie` command runs `bin/clankie.ts` under Node's native type stripping, so the whole dependency graph stays erasable TypeScript (no enums, namespaces, or constructor parameter properties) — enforced repo-wide by `erasableSyntaxOnly` in `tsconfig.base.json`.

## Layout

```text
src/face/    Ported v1 face components (theme, banner, spinners, outline,
             transcript viewport + blocks, command UI, interactive flow,
             autocomplete, chrome selection, SGR mouse, clipboard, bash escape).
             Verbatim ports — fix bugs upstream-style, don't restyle.
src/shell/   The face shell: layout assembly, central input router, overlay +
             selection plumbing, SetupFlow wizard engine, status bar, turn
             loader, prompt history. Extracted from v1's scripts/clankie.ts.
src/commands.ts   Console slash commands (/help /mission /doctrine /approvals
                  /eval /layout /clear /new /status /exit).
src/provider-commands.ts  /auth /model /effort wizards (VUH-760) over
                  @sapling/model-registry, @sapling/credential-broker, and
                  @sapling/model-provider (clankie.json config).
src/session/      Durable Eve client cursor, replay-safe stream renderer, and
                  empty placeholders for pending control-plane projections.
```

## Interactions

- Type `/` for the command typeahead; Tab completes, Enter runs.
- `Ctrl+/` opens the fuzzy command workbench; `Ctrl+T` toggles transcript focus.
- `!` on an empty input enters the inline shell escape (Esc exits; Ctrl+C kills the running command).
- Esc detaches from an in-flight captain turn. Eve has no server-side cancel
  route, so the durable turn continues and the TUI reconnects before sending
  another prompt.
- Mouse: wheel scrolls, drag selects (OSC-52 copy), scrollbar gutter drags, click collapses tool blocks.
- `/layout` moves the input/status bands, toggles the header, and picks the spinner (`CLANKIE_TUI_*` env vars seed the defaults).
- `/auth` manages provider credentials (API keys in the Keychain broker, ChatGPT/Codex OAuth, harness-login guidance); `/model` picks captain models from the models.dev registry; `/effort` sets reasoning variants. Non-secret config lands in `~/.config/clankie/clankie.json`.
- OpenAI API-key access is `openai/<model>`; ChatGPT subscription access is the
  explicit `openai-codex/<model>` provider. They never borrow each other's
  credentials.
- The Eve cursor is stored atomically with mode 0600 under
  `.data/tui/captain-session.json`. It is capability-like local state and is
  excluded from mission events and support bundles.

Known gap from the v1 port: drag-and-drop attachment paste rewriting stayed behind (`tui-attachments.ts` is coupled to the v1 brain's attachment pipeline); it returns with the control-plane attachment path.
