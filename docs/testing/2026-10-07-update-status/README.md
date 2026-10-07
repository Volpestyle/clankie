# VUH-1753: update progress and recovery wording

Evidence for [VUH-1753](https://linear.app/vuhlp/issue/VUH-1753).
The issue evidence comment records the landed revision.

The CLI and TUI share plain descriptions of scheduled, preparing, draining,
starting, refused, rolled-back and healthy updates. Failure and rollback details
remain visible. Recorded pre-cutover failure permits retry subject to holds;
uncertain results retain the original operation and lock and direct the owner to
reconnect and read status without resending or restarting. A recorded
reconciliation permits another update, subject to holds.

Historical holds remain blocking; no updater, canary, hold admission or audit
semantics changed. Only the authenticated owner may override reviewed holds,
with a reason and one audit per hold. Piped and explicit JSON keep structured
results; `accepted: false` now exits 1 even without an error field.

## Boundary evidence

`apps/clankie/test/runtime-update-ux.integration.test.ts` uses real Git, private
update journals, the hold store, loopback HTTP and bearer authentication. An
unfinished transaction prevents helper dispatch or deploy effects.

The tests verify:

- Live and target commits, grouped historical holds, canary policy and JSON.
- Owner authentication, required reasons, per-hold audits and a newly acquired
  hold blocking after interactive confirmation.
- Scheduled records older than ten minutes stay untouched by status GET.
- Preparing, draining, safe failed, uncertain failed, reconciled and healthy
  canary records give the corresponding next step while preserving the journal,
  original lock and all seven historical holds.
- A newer active lock cannot inherit retry advice from an earlier safe failure.
- A native HTTP server consumes a POST and drops its socket: the CLI sends that
  POST once, reports uncertainty, and only an explicit status read sends a GET.
- A shutdown HTTP response explains the drain/reconnect and stops terminal
  preview before another POST.
- Busy piped and explicit JSON requests exit 1 with their structured response.

## Checks

Focused checks passed through `clankie heavy --`:

- `pnpm exec vitest run --config vitest.config.ts apps/clankie/test/runtime-update-ux.integration.test.ts apps/tui/test/update-command.test.ts` — 14 tests passed.
- `pnpm --workspace-concurrency=1 --filter @clankie/tui --filter @clankie/clankie typecheck` — both packages passed.
- `pnpm exec oxlint --deny-warnings` on the four changed TypeScript files.
- `pnpm exec oxfmt` on changed source and docs, plus `git diff --check`.

The initial checks could not start because this worktree lacked dependencies;
`pnpm install --frozen-lockfile` restored them without changing the lockfile.
The first executable test run rejected a test reconciliation record with a
non-UUID instance ID. The fixture now uses a valid UUID, preserving validation.

No installed runtime update, real owner-hold override, deployment, restart,
release, eval or full suite was performed for this change. Full gates belong to
the separate assigned lane. The TUI consumes the same formatter; no interactive
live TUI or live cutover was exercised.
