# Focused checks

All commands ran from this isolated core worktree. Checks after James's limiter
instruction used `~/.herdr-handoffs/clankie-backlog-20261003/bin/heavy`.

- Membership/hire/native-observer/latency fixtures: 96 checks passed in four files.
  Earlier run; source then had the same hire-proof/native adapter changes.
- Final closure: 120 passed in eight files: project-onboarding, work-items,
  fleet-project-membership, settings project-enrollment, protocol project-onboarding,
  protocol fleet-project-membership, node-free-index, work-items convention.
- Boundary/authorization: 70 passed in three files: conversation-questions,
  project-create, project-onboarding-auth.
- Final guarded CREATE run: 74 passed in two files, including newly created
  tracker-parent replacement and saved-tracker/no-replay failures.
- Owner CLI/HTTP/captain/project-role integration: eight passed, including
  owner-started workspace members and remote qualified seats.
- `pnpm --filter @clankie/clankie typecheck`: exit 0 on the final source.
- `pnpm exec oxlint --deny-warnings` on changed TypeScript source/test files: exit 0.

The final closure run includes the partial tracker-save/no-replay regression.
An earlier version of that new assertion incorrectly compared optional failure
metadata with the durable status; it was corrected to check uncertain status,
identical proposal, absent success receipt and one write. The final run passed.
App checks and pending native evidence live in the app companion handoff.
No full suite, model eval or live native acceptance ran.
