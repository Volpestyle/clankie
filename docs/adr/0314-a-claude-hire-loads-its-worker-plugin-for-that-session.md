# ADR 0314: A Claude hire loads its worker plugin for that session only

Status: Accepted by James, 2026-10-31. Amends
[ADR 0187](0187-clankie-hires-his-own-seats.md) for Claude seats.

## Context

A Claude hire needed the `clankie-worker@clankie` plugin installed in the hire's
own Claude profile, from a marketplace Clankie registered there. Every machine
and every profile on it carried a copy: the Mac's profiles, both PCs' `.claude`
and `.claude-clowd`. Installs drifted from the running Clankie, the installer
enabled the plugin at user scope so it rode every hand-started session too, and
consent asked `claude plugin list` in the service's own environment instead of
the hire's profile, so a hire could be refused or admitted for the wrong reason.

Claude Code can load a plugin for one session from a directory with
`--plugin-dir`. Such a plugin's identity is `NAME@inline`. Its channel still
passes the same owner gate as an installed one: channels enabled in managed
policy, the plugin's `{ marketplace, plugin }` pair in `allowedChannelPlugins`,
and the plugin named in `--channels`. Managed `disableSideloadFlags` drops
`--plugin-dir` plugins.

## Decision

- **A Claude hire loads the worker from Clankie's own files.** Locally that is
  this install's `integrations/claude-plugin/worker`; on a fleet machine it is
  the copy `clankie herdr prepare` stages at `~/.clankie/claude-plugin/worker`
  (on Windows, under `%USERPROFILE%`). The launch passes
  `--plugin-dir WORKER_DIR --channels plugin:clankie-worker@inline`. Nothing is
  installed in, or written to, a Claude profile.
- **An older installed copy is switched off for that session.** The hire's
  launch settings set `enabledPlugins["clankie-worker@clankie"]` to `false`, so
  a profile that still has it does not load the worker twice.
- **The owner approves the inline identity once per machine.** Managed policy
  carries `{ "marketplace": "inline", "plugin": "clankie-worker" }` with
  `channelsEnabled: true`, and leaves `disableSideloadFlags` unset.
  `clankie herdr prepare` writes that entry on a fleet machine, keeping every
  other entry. On the Mac it is the owner's administrator step. Approving only
  the old `clankie` marketplace pair no longer admits a hire.
- **Consent reads what the launch will use.** A hire is admitted when the
  worker directory it will load exists on the launch machine and that
  machine's managed policy approves the inline pair. A remote machine reports
  its staged directory and policy in one read; the launch uses the directory it
  reported.
- **Tool names do not change.** The plugin's servers keep the
  `mcp__plugin_clankie-worker_*` names, so allowlists, deny rules and the
  bridge's channel check are the same, and the bridge accepts either identity
  in Claude's argv.

## Consequences

- One Clankie update reaches every hire on a machine; there is no per-profile
  install to drift.
- A machine needs its managed policy updated before it runs this code, or its
  hires stop at `consent_required` with the exact entry to add.
- Hand-started sessions and the Mac PATH shim still use the installed plugin
  until the installer stops installing it. Removing that install and every
  existing copy is the follow-up.
