# Codex hire cwd (#252)

PR: https://github.com/Volpestyle/clankie/pull/257

## Cause and change

`startHireWorktree` returns the new checkout's `workingDirectory`.
`captain-hiring.ts` copies that into the request; `HerdrWatchStore` passes it to
both `createTab({ cwd })` and the adapter's `SeatLaunch.cwd`. Claude runs in that
terminal. Codex can create its thread in an app-server, whose process cwd can be
different. The launch never explicitly selected a thread cwd.

A connected app's `start_agent` forwards its optional prompt to `hireSeat`.
Without a prompt, `HerdrWatchStore` skips the dedicated-server adapter and starts
plain Codex, which may connect to its shared daemon. Both this plain launch and
the adapter's remote view now explicitly pass `--cd` with the prepared directory.
A Codex pane with a missing or different observed cwd cannot confirm startup.
The dedicated adapter also checks the native `thread/read` cwd before binding
and before sending a brief; a mismatch fails without sending the brief.

## Evidence on the Mac

All installs, builds and checks ran through `clankie heavy --` in the dedicated
`wt-codex-hire-cwd` worktree. No existing service, shared app-server, worker or
owner window was restarted or driven. No model provider turn was used for the
native cwd proof.

- `pnpm exec vitest run apps/clankie/test/codex-app-server.test.ts apps/clankie/test/codex-hired-seat-protocol.integration.test.ts apps/clankie/test/desktop-codex-hire.integration.test.ts apps/clankie/test/codex-seat-hire.test.ts apps/clankie/test/codex-seat-driver.test.ts`:
  78 passed; the desktop process proof initially skipped pending its native helper.
  The protocol regression checks the explicit launch cwd and refuses a pane in
  another cwd, for both briefed and unbriefed hires; no brief is sent on refusal.
- `pnpm fleet-proof:build`, then
  `pnpm exec vitest run apps/clankie/test/desktop-codex-hire.integration.test.ts`:
  2 passed, with the process proof enabled. The actual adapter, Unix-socket RPC,
  desktop runner, launch handoff, child process, registry and process proof run
  together. The desktop socket and Codex executable/server are fixtures; this
  establishes the launch argument and binding boundary, not installed-app E2E.
- `CODEX_HISTORY_NATIVE_TEST=1 clankie heavy -- pnpm exec vitest run apps/clankie/test/codex-fresh-history-native.integration.test.ts -t 'hire passes its cwd'`:
  2 passed against the installed Codex app-server in an owned credential-free home.
  The process starts in one directory while the thread receives another from the
  view's `--cd` argument. The native API returns the selected cwd; intentionally
  omitting it reproduces the server-cwd fallback and Clankie rejects startup.
  This exercises native `thread/start`/`thread/read` without a `turn/start`.
- Remote discovery and terminal-retention regressions: 2 passed. Resource-holder,
  seat-adapter-hire and project-hire-pane checks also passed.
- Scoped formatting and lint passed for the changed files.

## After the next update

Once the updated service is loaded, a new hire carries the prepared cwd in its
Codex launch, so the shared daemon's old process cwd cannot silently select the
new thread's directory. A failure to honor that selection is refused by the
native adapter's cwd check; a wrong pane cwd leaves either launch unconfirmed.
Existing threads keep their cwd; this change does not repair or restart them.

Installed-desktop E2E remains unproven. A credential-free pseudo-terminal TUI
attempt did not create a thread, so the native proof uses the real RPC boundary
instead. The next live check is a fresh desktop Codex hire reporting `pwd` and
its branch against its prepared checkout. The lead owns that check and landing;
this task stops at the ready PR.
