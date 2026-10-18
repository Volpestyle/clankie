# VUH-2417: OpenCode and Grok workers on their latest releases

James, 2026-10-17: harnesses stay on their latest release. Installed here:
OpenCode **1.19.3** and Grok Build **1.0.50**. The adapters had pinned 1.18.18
and 1.0.46 exactly. They now admit the installed release at or above a floor
when a probe of the surfaces Clankie calls passes, and refuse with the found
version and what is missing otherwise. Nothing was downgraded.

## What changed between the releases

**OpenCode 1.18.18 → 1.19.3** (upstream tags `v1.18.18` `31406ccc5`,
`v1.19.3` `e3c4eb242`; the old pin named source commit `4643e65ad`):

- `packages/core/src/database`: no schema or migration change. `schema.gen.ts`
  and `migration.gen.ts` are unchanged; only legacy-import and
  `workspace-name` migration robustness changed.
- `packages/sdk/js/src/v2`: no method change; doc strings, `chunkTimeout`,
  `reasoning_options` and a required `upgrade` target only.
- `packages/plugin`: version bump only. `readV1Plugin` (internal loader in
  `packages/opencode/src/plugin/shared.ts`) and `plugin/tui/runtime.ts` are
  unchanged, so the default `{ id, tui }` entry still loads. OpenTUI and Solid
  stay at 0.4.5 and 1.9.10.
- `packages/tui/src/app.tsx`: still awaits plugin start before mounting a
  prompt; adds an update notice and removes the auto-update dialog. The session
  route drops share commands. The terminal title truncation now ends in `…`.
- The semantics behind the floor hold on 1.19.3: `app.tsx` sets `ready` only
  after `pluginHost.start` settles, `session/status.ts` deletes idle entries, and
  the session route's final reply still excludes `tool-calls` and `unknown`.
- `tool/task.ts`: a failed subagent now fails the task call
  (`Subagent failed (task_id: …)`). The task projection already ends an
  `error` call as done (inferred from its source; not exercised live).

**Grok Build 1.0.46 → 1.0.50**: no public source exists for either (the
public `xai-org/grok-build` tree is at 1.0.45), so both installed binaries were
run as leaders against a scratch `GROK_HOME` and compared
([grok-leader-probe.json](grok-leader-probe.json)). Both register with leader
protocol 1 and the same leader capabilities (`control_v1` true), answer
`get_leader_info` with the same fields (1.0.50 adds `other_client_count`), and
initialize ACP at protocol 1 with `loadSession: true`, the same capability and
`_meta` keys and an `agentVersion` equal to the binary. The notification set and
the `_x.ai/mcp/list` shape match.

## Admission now

- **OpenCode**: the isolated `--version` must be a plain release at or above
  1.18.18. On load, `worker-tui.mjs` probes every TUI and SDK call a worker
  makes; a missing one answers `initialize` with
  `OpenCode VERSION lacks the Clankie worker surface: …`, which the controller
  relays to the hire's `detail`. The TUI must report the probed version. The
  history reader admits added columns and later migrations, and requires the
  columns, indexes and migrations it reads plus a session version at or above
  the floor that matches the one registered. Remote linked-Mac hires use the
  same floor and probe.
- **Grok**: `grok --version` must be at or above 1.0.46; the leader must report
  protocol 1, `control_v1` and the same version; ACP must initialize at
  protocol 1 with session loading and the same agent version. Each failure names
  the version and what it lacks; nothing is briefed.
- **OpenCode operator seat** (`clankie opencode`): 1.18.0 or newer with the
  `--session`, `--hostname` and `--port` flags; a missing flag is named.

The floors stand only for semantics no probe sees; each floor's comment says
which (`OPENCODE_WORKER_FLOOR` in `apps/clankie/src/opencode-history.ts`,
`GROK_NATIVE_FLOOR` in `apps/clankie/src/captain/grok-native-controller.ts`).
