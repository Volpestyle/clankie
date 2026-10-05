# VUH-1656: guided self-hosting

Issue: [VUH-1656](https://linear.app/vuhlp/issue/VUH-1656).
Worker: Odile. Isolated worktree: `clankie-wt/vuh-1656`, branch `feat/vuh-1656`,
base `887e07f6` (origin/main). No live service restart, deployment or push.

## Slice 1: doctor summary

- `clankie doctor` emits one human line. Missing model/sign-in and endpoint
  failures precede service/phone faults and optional integration remediations.
- `--json` retains the report shape and existing exit behavior, including
  `--machine NAME`. Internal typed report consumers and `/doctor` keep the card.
- Searched `scripts`, `apps`, `packages`, and sibling `clankie-app`/`clankie-ops`
  scripts for doctor callers. The headless CLI test parsed stdout; migrated it
  to `--json`. Setup consumes `doctorCommand` directly, not formatted stdout.
- Real `pnpm install --frozen-lockfile`: passed, 579 packages, no dependency or
  cache symlinks to another checkout.
- Focused checks: `pnpm exec vitest run apps/tui/test/headless-captain.test.ts
apps/tui/test/install-doctor.test.ts apps/clankie/test/fleet-membership-route.test.ts`:
  **31 passed across 3 files**. Checks cover default line, explicit JSON,
  endpoint failures/keys, ready, and unchanged machine card boundaries.
- `pnpm --filter @clankie/tui typecheck`: passed.
- Ready describes these probes, not a completed model turn or native tool
  acceptance. A clean user account and real subscription sign-in remain pending.
