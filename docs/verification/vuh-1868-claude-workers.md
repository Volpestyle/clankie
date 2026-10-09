# Claude worker permissions: VUH-1868

## Hired auto mode — 2026-10-09

James decided that hired Claude workers use `auto` mode without blanket ask
rules. Launch settings preserve tracker denies and enable only the worker MCP
server; they do not allow all Bash. Managed policy and plugin permission hooks
are unchanged. [ADR 0246](../adr/0246-worker-questions-use-native-hook-answers.md)
records the decision.

Checked in the task worktree based on `f545f88d`:

- `pnpm exec vitest run apps/clankie/test/claude-worker-seat.test.ts
apps/clankie/test/remote-claude-isolation.test.ts
apps/clankie/test/claude-hook-questions.integration.test.ts
apps/clankie/test/claude-hook-command.integration.test.ts`: **4 files, 80 tests
  passed**. Launch assertions cover auto mode with and without gate settings,
  no blanket ask or Bash allow, tracker denies and exact session resume. Real
  command-hook checks cover allow/deny, HTTP and stdout acknowledgment;
  registry checks cover wrong sessions, duplicate answers, expiry and cancellation.
- `clankie heavy -- zsh -c 'pnpm install --frozen-lockfile && pnpm --filter
@clankie/clankie typecheck'`: **passed**.
- Scoped `oxfmt`, `oxlint --deny-warnings` and `git diff --check`: **passed**.

These are launch and transport checks, not live Claude model acceptance.
No deployment, PC input, account changes or existing-pane steering occurred.
