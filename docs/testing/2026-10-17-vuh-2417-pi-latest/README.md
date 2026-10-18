# VUH-2417: native Pi workers on the installed release (Pi 1.3.0)

James, 2026-10-17: harnesses stay on their latest release, and a newer one must
never silently make a harness unhireable. Pi 1.3.0 became the global install
that day, while native Pi capability accepted exactly 0.87.1 and its published
bundle hashes. This change admits whatever Pi is installed when it passes a
hire-time probe, and refuses anything else by name
([ADR 0250 amendment](../../adr/0250-pi-workers-use-the-same-usability-view.md)).

## What changed between 0.87.1 and 1.3.0

Compared from the installed 1.3.0 package and 0.87.1 in a temporary prefix:

- **Extension API.** Every event, context method and `pi` method the worker
  runtime and fleet consumer use still exists with the same shape:
  `session_start` (`reason: "startup"`, `ctx.mode: "tui"`), the session
  switch/fork/tree/shutdown events, `ui_prompt_start`/`ui_prompt_end`,
  `message_start`, `agent_settled`, `before_agent_start`, `tool_result`,
  `sendMessage(..., { triggerTurn, deliverAs })`, `registerTool`,
  `get/setActiveTools`, `getAllTools`, and `isIdle`, `isProjectTrusted`,
  `hasPendingMessages`, `signal`, `abort` and the session manager reads.
- **Semantics that moved (1.2.0).** `before_agent_start` now also runs for an
  idle `sendMessage(..., { triggerTurn: true })` run, before the custom message
  enters the loop, and a starting run counts as busy. The fleet consumer waited
  there, unbounded, for its MCP catalog, so a brief's native receipt could miss
  the ten-second send deadline while the worker went on to do the work
  (observed live, below). The wait is now bounded at 20 seconds and the brief's
  receipt window is 30 seconds.
- **Tool results.** 1.x also reads a returned `isError`; the fleet consumer's
  `tool_result` override still applies and is what 0.87.1 needs.
- **Session files.** Header version 3 and `<timestamp>_<uuid>.jsonl` under the
  profile's `sessions/--cwd--/` are unchanged. The file is still created lazily.
- **Bundle layout.** `dist/bundle/cli.js` still requires `./cli-runtime.js`,
  which imports its chunks statically (8 in 0.87.1, 18 in 1.3.0, about 4.5 MB
  either way). Chunk names change every release, which is why published hashes
  cannot follow upgrades.
- **Auth and models.** `auth.json`, `models.json` and `settings.json` keep their
  shape. The captain's 1.0.0 reader resolves a 1.3.0 profile's
  `openrouter/~anthropic/claude-haiku-latest`. 1.0.3 renamed the Azure provider
  to `azure`.

## The probe

`integrations/pi-plugin/probe.mjs` runs with the selected native Node, offline,
in a throwaway profile, against a local OpenAI-compatible endpoint
([how it works](../../../integrations/pi-plugin/README.md#release-probe)). It
loads its extension through Pi's own loader and drives the real worker runtime:
identity and session layout, dialog blocking, custom-message receipt, follow-up
turn, settlement, the MCP tool-error override and the persisted header.
[probe.jsonl](probe.jsonl): both 0.87.1 and 1.3.0 pass in about 1.1 seconds on
Node 26.7.0. Breaking the receipt check or the tool-error hook in a scratch copy
fails with `receive a custom-message brief: delivery unconfirmed` and
`mark an MCP refusal as a tool error: tool_result isError override ignored`.

A release below 0.87.1, an unrecognized bundle or a failing probe is refused
with `Native Pi VERSION ...`, in the hire and in `worker_accounts`
(`pi-native-capability.test.ts`, against synthetic installs and the real probe).
The native acceptance slices that VUH-2414 guards on this same check now run:
with the global 1.3.0, all 14 (11 fleet, 2 accounts, 1 integrate-environment)
run and pass, and they also pass with 0.87.1 first on `PATH`.

## Live hire

LIVE_HIRE_RESULT

## What this does not prove

Hosted Linux hires, billing and Discord-origin completion remain the open owner
acceptance in the [Pi acceptance boundary](../2026-10-04-pi-workers/README.md).
The Linux image now pins 1.3.0; the Linux process proof
(`scripts/proof-linux-pi-process.mjs`) was not rerun. The probe drives the
package's SDK build, not the CLI bundle a hire launches; the live hire covers
that bundle on 1.3.0 only.
