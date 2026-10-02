# Clankie in Codex

`clankie seat --harness codex --conversation ID` opens Clankie's operator seat
in the real interactive Codex TUI, on the owner's Codex plan. The service keeps
his body and social lanes. Requires a running Clankie service and Codex CLI
with plugins, hooks and app-server support (developed against 0.159.1).

## Install and trust

From a checkout or installed release:

```sh
# Checkouts only: materialize skills (Codex's installer skips symlinks).
node integrations/codex-plugin/build.mjs
codex plugin marketplace add /absolute/path/to/clankie/integrations/codex-plugin
codex plugin add clankie@clankie-seat
clankie seat --harness codex --conversation ID
```

Keep the plugin disabled globally through Codex's `/plugins`; the launcher
enables it for its own thread. In the seated TUI, open `/hooks`, inspect the
Clankie definitions, and trust them yourself. Exit and repeat the original launch command to run the trusted session-start hooks.
After its first conversation turn, `clankie seat --harness codex --resume` reopens it.
Changed hook definitions require review again. The launcher reports this as
`hook_trust_required` in `--dry-run` and on stderr. It never bypasses trust or
writes Codex's trust records. An untrusted seat does not bind the wake outbox.

Use an existing conversation ID from `clankie conversations list`. Omission
selects the owner's global head. Live verification must select a new scratch
conversation and close its own seat afterward. Codex and Claude maintain
separate resume records; resume cannot rebind a thread to another conversation.

## Components

- `.codex-plugin/plugin.json` and `.agents/plugins/marketplace.json` use native
  Codex plugin discovery and installation.
- `build.mjs` generates `instructions/clankie.md` from
  `apps/clankie/src/captain/instructions.md`. Codex has no Claude output style;
  the trusted `SessionStart` hook adds these instructions to Codex's own
  developer context, followed by `clankie prompt`'s live service sections.
- `hooks/hooks.json` declares native command hooks. `SessionStart` re-arms
  `clankie memory-card --hook`; `UserPromptSubmit` emits the first card and
  changed cards only. Sync hooks upload redacted native transcript entries to
  the selected conversation for the app. Child session hooks are excluded.
- `.mcp.json` starts `clankie mcp --lane operator`, forwarding the selected
  conversation and service URL by environment name. Credentials stay in the
  broker; no bearer is embedded in this plugin.
- `skills/` is an ignored installation snapshot of the shared product and optional
  skill bundle, materialized by `build.mjs`; Codex's installer skips symlinks.
  Release assembly also copies the canonical skill sources into this directory.
- The launcher reuses the Codex app-server seat driver for native turn delivery
  and `pumpSeatEvents` for the existing conversation outbox. Wakes, watches and
  escalations never type into the terminal. Only this launch's app-server closes
  when the TUI exits; the shared daemon and other seats are untouched.

After changing identity instructions, regenerate both seat projections:

```sh
node integrations/claude-plugin/build.mjs
node integrations/codex-plugin/build.mjs
```

Refresh an installed plugin with the native install command after changing its
files. The source can be selected with `--plugin-dir PATH`; it must remain a
native Codex plugin marketplace, not a Claude plugin.

Native contracts: [plugin packaging](https://developers.openai.com/plugins/build/plugins),
[hook trust and events](https://learn.chatgpt.com/docs/hooks), and
[app-server](https://developers.openai.com/codex/app-server).
