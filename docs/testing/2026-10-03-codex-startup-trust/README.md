# VUH-1551 — Codex startup trust lifetime

Base: `f37ee0f5`; isolated worktree `sol/vuh-1551`. No main-checkout edits.

- [Live probe](live.json): the native Codex TUI showed **Hooks need review**
  using a temporary worker overlay of registered account `jamescvolpe`.
  After 15,108 ms, the original Unix socket still answered `initialize`,
  `thread/loaded/list` (no thread yet), and `config/read`. No trust approval,
  login, model turn or automated terminal message was sent. The probe's own
  pane and server were closed and temporary overlay removed afterward.
- An initial probe hit the same prompt but its evidence reader incorrectly
  parsed Herdr's plain-text pane read as JSON. It cleaned up its own pane/server;
  the corrected probe above completed. Owner focus was unchanged in both.
- Native `hooks/list` independently reported `review_required` for that account.
  Only this status was retained; hook commands and credentials were not logged.
- [Focused checks](focused-tests.txt): 104 tests pass in seven files covering
  discovery lifetime, owner-review continuation, exactly-once original brief,
  pane-close cancellation, trust marker reporting, account diagnostics and hire
  behavior. The native-protocol fixture tests continuation after owner review;
  the live probe deliberately did not approve the prompt.
- [Account recheck](account-recheck.txt): 11 tests pass after making the two
  read-only diagnostics concurrent (bounded together instead of serial timeouts).
- Targeted production-file oxlint passed; `git diff --check` passed.
- [Required pnpm check](check-blocked.txt) stopped at pre-existing formatting in
  `packages/agent-transcript/src/sessions.ts`.
- [App typecheck](typecheck-blocked.txt) stopped at pre-existing
  `apps/clankie/test/linear-wake-api.test.ts:81`: mocked successful `McpCallResult`
  lacks `isError`. Both baseline repairs were subsequently reported on main by
  the parent lane; this branch did not edit those unrelated files.

Parent integration review rebased the implementation to main `2adc66b9`
(implementation `d9ef0d6a`) and ran the required full `pnpm check`: **pass**,
exit 0. Typecheck passed; all 408 Vitest files passed (3,398 tests passed,
2 skipped), followed by all 124 Vox Rust tests and Vox IPC smoke. The earlier
blocked logs above preserve the original baseline observations. Parent retained
the complete integration log in the backlog handoff evidence directory.

The owner still decides hook and repository trust. Headroom selection is
unchanged; account list/API reads report `hookTrust` from native `hooks/list`
for the account home. Repository-specific trust cannot be predicted by that
home diagnostic. Unsupported/failed diagnostics report `unknown`.

Startup may return pending before a native thread exists; the same in-memory
startup later registers the actual thread and sends the original brief once.
Closing its pane cancels pending startup. A service restart still loses that
in-memory continuation; the native server survives, as before. The pending
original brief is not durable across a service restart.

A local server PID lifecycle callback was added for the separate VUH-1548
security lane's server-owned controller binding. That lane owns the registry
and authorization integration. Remote launchers expose no local PID.

No evals were executed. The existing eval account mock was updated solely for
the newly exported read-only diagnostic used by account selection.
