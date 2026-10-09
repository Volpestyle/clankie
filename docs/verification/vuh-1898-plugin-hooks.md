# VUH-1898 precursor: contained Claude hook modules

Verified on 2026-10-09 with native Claude Code 2.1.295 in an owned throwaway
Herdr pane (`w47:p11`). The pane was stopped and closed after capture.

`build.mjs` copies the canonical `worker/mods/tool-catalog.mjs` into each
plugin's `hooks/mods/` directory. Both `hooks.json` files declare
`./mods/tool-catalog.mjs`. The build's `--check` verifies both copies.

Native `/reload-plugins` after generating these files reported:

```text
Reloaded: 1 plugin · 13 skills · 7 agents · 11 hooks · 1 plugin MCP server · 0
plugin LSP servers
```

There was no load-error line (Claude displays that line only for nonzero errors).
The native debug log independently confirmed loading and catalog execution:

```text
2026-10-09T04:22:41.492Z hooks module clankie@inline loaded (worker, environment 5, tier user); events: session.start,session.end,turn.start,turn.complete,tool.call,classic.SessionStart,command.run
2026-10-09T04:22:41.550Z hooks module clankie@inline session.start settled in 52.6ms (worker hop, next() included)
2026-10-09T04:22:41.559Z hooks module cc-plugin-sec-default@builtin (native): tool.list nested in clankie
```

The visible catalog check warned `HTTP 403, native_session_required`: this
standalone proof pane had no admitted service binding. This proves execution,
not successful service authentication or a matched catalog.

Local raw capture: `.local/vuh-1898/reload-native.txt`; filtered module trace:
`.local/vuh-1898/reload-catalog-proof.txt`. Full debug context remains local.

Checks: 30 tests passed across `claude-plugin.test.ts`,
`harness-profiles.test.ts`, and `claude-tool-catalog-mod.integration.test.ts`.
After correcting the generated destinations, build and `--check` passed and
the native reload above verified the paths. The test inputs were unchanged;
the redundant queued rerun was canceled. Scoped formatting and lint passed.
