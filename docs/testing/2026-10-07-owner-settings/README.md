# Owner settings APIs — 2026-10-07

VUH-1813 core gaps 4 and 6. Fresh worktree based on current origin/main.

Host keep-awake and automatic updates now have revision-fenced owner APIs.
Fleet, persona, voice, Discord fields, worker-account holds and Linear
follow/wake use the owner API from CLI and TUI, including hosted transports.
Device routes carry host, voice, holds and Linear settings. Persona devices
retain the existing talkativeness-only projection.

The service validates before persistence and rechecks owner authority at
commit. Wizards retain the displayed revision. API failures never fall back
to local settings writes. Host apply failures preserve the saved receipt
through the relay. Shared host wording lives in protocol.

See [ADR 0248](../../adr/0248-owner-settings-use-one-revision-fenced-api.md),
[CLI contract](../../cli.md) and [inventory](../../settings-inventory.md).

## Verification

Every heavy command ran through `clankie heavy`.

- All 29 workspace typechecks passed in the landing gate.
- Focused tests exercised real routes, durable settings, owner credentials,
  signed device sessions, relay forwarding and real child-process boundaries.
- `pnpm check:landing --maxWorkers=2`: passed; 805 files and 7,401 tests passed,
  with 19 files and 49 tests skipped by existing opt-in boundaries. Formatting,
  lint, knip and cheap documentation checks passed.
- `pnpm docs:check`: passed; 10 pages, 90 network routes, 197 API operations
  and 75 slash commands. Links and anchors resolve.
- `pnpm deadcode`: passed; no unused exports or dependency errors.
- Focused Discord/Linear group: 78 tests in 10 files passed, including
  competing owner edits during advanced Discord and Linear prompts.

Legacy file-writing fixtures now use real owner APIs. An upstream tidy fixture
started multiple Git worktree mutations in one repository concurrently; these
setup writes are now sequential. Its focused authenticated-pruning case and
the final related suite passed. An earlier body-recovery timing timeout under
machine load passed in isolation (15 tests) and in the final related suite.
The public docs extractor also accepts a formatted multiline command description.

Boundary coverage includes stale writes, competing writes, revoked credentials
and devices while a write is queued, voice environment validation, cleared
voice models, restricted persona projection, host platform/managed policy,
saved-but-unapplied keep-awake receipts and refusal to write offline.

App/dashboard control binding remains a separate lane. No deployment, service
restart, release, simulator, provider call or eval was performed. Native
keep-awake process behavior uses retained launcher fixtures; these checks do
not toggle the owner's real sleep assertion.
