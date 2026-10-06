# Windows Codex hook command loading (VUH-1709)

Candidate built from `origin/main` `1eb8ea93`, tested 2026-10-06. Both the worker
and operator Codex hook commands now read `PLUGIN_ROOT` inside Node, convert the
path with `pathToFileURL`, and import their existing entrypoints. The worker
passes `--codex` after Node's option terminator. No shell expands the plugin path.
Worker package version is 0.6.6; operator Codex package version is 0.1.1.

[Windows shell results](windows-shells.jsonl) contain 22 successful invocations:
all four worker and seven operator events through both `cmd.exe` and Windows
PowerShell on the actual PC. The staged plugin root included spaces, `$`, and an
apostrophe. Staging was removed after the run. No installed plugins, account
homes, configuration, desktops, or existing panes were changed.

These were entrypoint-loading checks with no Herdr pane or operator binding.
They prove the shell/path defect is fixed; they do **not** establish seating,
trusted native hook execution, message delivery, or model awareness.

Focused Mac checks:

- `codex-plugin.test.ts`, `codex-hook-command.integration.test.ts`, and
  `codex-tool-catalog.test.ts`: 19 passed. The integration test loads both real
  plugins through the native shell; the existing catalog test now executes the
  manifest's actual command instead of bypassing it with a direct script path.
- Clankie and TUI typechecks passed.
- Scoped oxlint passed; changed-file formatting and `git diff --check` passed.

Remaining acceptance: Clankie must approve refreshing the installed PC plugin,
then an owned fresh Codex pane must run SessionStart, prompt and Stop without
hook errors and show its session seated in Clankie's roster. Changed native hook
definitions require the owner's `/hooks` trust review. Linux was not run; POSIX
behavior has Mac shell evidence only. Leave the issue open until live evidence
covers its acceptance criteria.
