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

Remaining acceptance: an owned fresh Codex pane must run SessionStart, prompt
and Stop without hook errors and show its session seated in Clankie's roster.
Changed native hook definitions require the owner's `/hooks` trust review.
Linux was not run; POSIX behavior has Mac shell evidence only. Leave the issue
open until live evidence covers its acceptance criteria.

Native contract confirmation: the [official Codex hooks documentation](https://learn.chatgpt.com/docs/hooks)
identifies `PLUGIN_ROOT` as the installed plugin root supplied to hooks. The local
OpenAI Codex source at `008bbd5884122dc95aaece19ecfe0fc6a59dcf36` sets it in
`codex-rs/hooks/src/engine/discovery.rs` and applies hook environment variables in
`engine/command_runner.rs`. That runner selects `COMSPEC`/`cmd.exe /C` on Windows
and `SHELL`/`/bin/sh -lc` on POSIX. Reading the environment in Node follows the
native contract without depending on either shell's variable syntax.

The additional harness-profile version check passed, 9 tests (28 focused tests
in total). No executable inputs changed after those checks.

## Deployed PC update and native trust boundary

Clankie confirmed and authorized runtime `f6260751` on 2026-10-06. The normal
update succeeded from the registered `/Users/james/dev/clankie` project context:
`clankie herdr prepare pc --codex-source-setup C:\Users\volpe\dotfiles\scripts\codex-worker-setup.py --approve`.
The worktree context initially refused with HTTP 409 before changes. The normal
path then installed worker 0.6.6, ran the existing source-owned setup script and
preserved the Codex config link. [Version/config proof](live/pc-update.json).

Owned test pane `w9:p8` (`term_65d256106c3b9b`) launched native Codex 0.160.1
with `--no-daemon` and one bounded initial prompt. Its native `/hooks` review
showed three new or changed hooks: the worker SessionStart and UserPromptSubmit
definitions were inactive pending review. Opening review allowed the model turn
to complete with `TESS_VUH1709_WINDOWS_HOOKS_OK`, while those hooks stayed
untrusted. That answer establishes account/model availability, not hook execution
or Clankie seating. [Native observation](live/native-hook-review.txt).

No hook trust records were changed. The test pane was idle with an empty prompt
before closing; [cleanup](live/cleanup.json) confirms it is absent. The original
five PC panes were preserved. VUH-1709 remains open. The next decision is owner
review/trust of the changed worker hooks through native `/hooks`, followed by a
fresh owned-pane hook/seating check. A controller-owned trust fix is being tracked
separately in VUH-1738; this run does not assume that fix is deployed.
