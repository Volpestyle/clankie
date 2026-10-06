# Windows Codex hook command loading (VUH-1709)

Live Windows acceptance passed after the normal PC update and James's explicit
authorization to accept the known worker hooks. The [trusted native run](#trusted-native-windows-acceptance)
shows actual hook output and the matching seat in Clankie's service roster.

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

The shell checks preceded the owned fresh-pane acceptance below. Linux was not
run; POSIX behavior has Mac shell evidence only.

Native contract confirmation: the [official Codex hooks documentation](https://learn.chatgpt.com/docs/hooks)
identifies `PLUGIN_ROOT` as the installed plugin root supplied to hooks. The local
OpenAI Codex source at `008bbd5884122dc95aaece19ecfe0fc6a59dcf36` sets it in
`codex-rs/hooks/src/engine/discovery.rs` and applies hook environment variables in
`engine/command_runner.rs`. That runner selects `COMSPEC`/`cmd.exe /C` on Windows
and `SHELL`/`/bin/sh -lc` on POSIX. Reading the environment in Node follows the
native contract without depending on either shell's variable syntax.

The additional harness-profile version check passed, 9 tests (28 focused tests
in total). No executable inputs changed after those checks.

## Initial deployed PC update and native trust boundary

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

In this initial run, no hook trust records were changed. The test pane was idle with an empty prompt
before closing; [cleanup](live/cleanup.json) confirms it is absent. The original
five PC panes were preserved. VUH-1709 remained open pending owner authorization
to trust the changed worker hooks and a fresh hook/seating check. A controller-owned
trust fix is being tracked separately in VUH-1738; this run did not assume that fix
was deployed.

## Trusted native Windows acceptance

James explicitly authorized the lead's fleet to answer startup trust prompts in
owned PC test panes. Before accepting trust, native `/hooks` review showed that
all three changed definitions were from `clankie-worker@clankie-fleet`:
SessionStart, UserPromptSubmit and Stop. Each used the deployed Node environment
lookup above. The existing user SessionStart hook was already trusted.
[Reviewed worker definitions](live/trusted/reviewed-hooks.txt).

In owned pane `w9:pA`, the selected native option was **Trust all and continue**.
It succeeded and the model turn completed without a reconnect failure.
[Trust choice and key result](live/trusted/trust-choice.txt). Two subsequent fresh
owned native Codex 0.160.1 panes started without another trust prompt and completed
their bounded initial turns using `--no-daemon`.

The final fresh pane `w9:pC` (`term_65d25baabbec611`, session
`01a10fce-0729-7ab0-8a5c-cfcc8cc80fea`) produced the worker's actual SessionStart
output, `Hook · Clankie tools: …`, and completed its prompt/Stop cycle without a
hook failure or exit-code-1 warning. Herdr reported `done`, with an empty draft.
[Native turn and session identity](live/trusted/native-turn.txt).
Clankie's authenticated service roster independently reported that exact seat
and Codex session, with its worker bridge ready and a passed outcome.
[Service seating evidence](live/trusted/seated.json).

This embedded test session's native tool catalog remains `unverified`, as the
hook output explains; catalog verification and native message delivery belong to
the managed-hire acceptance on VUH-1527. Quiet UserPromptSubmit and Stop callbacks
did not leave individual exit-status records in the captured UI. The evidence
combines reviewed trusted definitions, a complete native lifecycle without hook
errors, positive SessionStart execution and independently observed seating.
It does not claim a `--remote` reconnect check or a fix for VUH-1738.

Every test pane created in these checks was closed after checking identity, idle
state and an empty draft. The final [cleanup census](live/trusted/cleanup.json)
contains exactly the original five pane identities. No accounts or Codex config
were changed; only the explicitly authorized native hook trust was accepted.
The executable source and plugin package inputs are unchanged from the 28 focused
tests, two typechecks, scoped lint and 22 Windows shell invocations above.
