# VUH-1407 managed Codex and pi workers

Issue: https://linear.app/vuhlp/issue/VUH-1407

## Candidate and decisions

Swarm source commit: `b62a68f087e9eb8685398db37b9963618d4046d4`, based on
`0981253fc4b81fb4794ceaa706aeec363d900a32`. The candidate tarball SHA-256 is
`4e576996a51753876bb83fa8ae5d7d63866189eb359fa29b7eb9591de2d4205e`.
`vendor/provenance.json` records the reproducible patch and artifact checksums.

Runtime API, CLI and TUI select `claude`, `codex` or `pi`; routed assignments can
require an explicit harness. Codex uses `gpt-6-astra`. Selection survives intent
storage and physical receipts. Unsupported harnesses and mode combinations refuse
without falling back. Codex and pi use stream mode, per-launch enrollment and MCP
configuration; no global harness configuration changes are needed.

ADR 0180 and ADR 0194 have amendments. Harness and mode remain independent axes.
This candidate adds schema 15 for the harness column. The unmerged
`vuh-1380-interactive-workers` branch separately uses schema 15 for mode: integration
must sequence those migrations under distinct versions before combining builds.
Remote PC enrollment remains on the existing shared coordinator relay.

## Completed checks

- Swarm `bun run check`: passed, 204 tests / 1,814 assertions, Python test,
  typecheck, build and 62-file package verification.
- Clankie focused API/CLI/TUI and route checks: passed, 3 files / 20 tests.
- Clankie `pnpm check`: passed, 336 test files, 2,811 tests and 1 skipped;
  123 Rust tests; IPC smoke; formatting, lint, dead-code, docs, infra and typecheck.
  This check used the installed schema-14 dependency, verifying compatibility and
  typed refusal before upgrade. It does not establish live candidate support.
- Protocol fixtures exercise Codex app-server and pi RPC wrappers with real Swarm
  MCP calls: readiness, ack, progress, renewal, completion, cancellation and release.
  Fixtures are not live harness/model canaries.

Local check logs: `/tmp/vuh1407-swarm-check.log`,
`/tmp/vuh1407-clankie-focused.log`, `/tmp/vuh1407-clankie-check.log`.

## Live proof pending

The candidate is prepared, not installed. The lead must coordinate the install,
lockfile update, SQLite backups and shared owner/service restart. No install or
service restart was performed by the implementation owner.

After that window, run one real managed canary on the Mac default runtime for
Codex and one for pi. Each must load the skill and instruction snapshot, ack its
fenced claim, report compatibility and harness/model, finish `completed`, and
release with status `released`. Preserve stable intent IDs on uncertain responses.
Record task IDs, launch receipts and release evidence here before closing the issue.
