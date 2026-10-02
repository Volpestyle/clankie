# Managed Swarm repair — September 27, 2026

The Mac service and staged Windows peer runtime use upstream `0981253`, schema
14, with identical source digests. [Sanitized receipts](proof.json) record the
clean-package and managed-worker checks. No schema-15 interactive-worker changes
are included.

## Changes

- Integrated the completed lifecycle fixes: launch-bound POSIX stop proof when
  MCP is unavailable, obsolete assignment/cancellation expiry, assignment-level
  progress deadlines, idle coordinator retirement, and backlog diagnostics.
- Included the long-transcript/subagent Claude hook fix and the existing PC
  Claude/Codex launcher CLIs on upstream main.
- Replaced Clankie's vendored artifact and lockfile integrity with the exact
  upstream build. There is no local source patch.
- Held managed dispatch, checked for live owned wrappers, took online SQLite
  backups of both live databases (integrity `ok`), stopped the service and its two
  owners, installed the artifact, and restarted the service and dependent portals.
  The launcher escalated the service shutdown after its SIGTERM timeout; startup
  health checks then passed. Other Herdr panes and the Rivals runtime were retained.

## Live verification

The clean packed runtime starts an owner, serves all nine MCP tools, sends a
message, fetches it and explicitly acknowledges it on both macOS and Windows.
The Windows install is a separate immutable directory; no active Rivals files
were replaced.

Clankie's native seat dispatched `lead-p2G-canary-0981253-1` through the default
managed runtime. The worker acknowledged its assignment, reported its platform
and matching compatibility, and completed task
`9778bfa3-b26a-40d4-829b-57b9cd000cd0`. The creator released the same intent. A
read-only database check confirms `completed` / `released`.

The PC fleet relay reports ready. Its authenticated cross-machine proof and CLI
routing repair belong to [the remote fleet record](../2026-09-27-remote-fleet/README.md).

## Limits

Historical uncertain launches are retained until valid stop proof exists; missing
panes or expired leases never authorize reassignment. The new stop latch does not
retrofit old wrappers, and Windows retains cooperative termination proof. Native
clients connected before a service/owner restart may need their MCP connection
reopened. No production hosted image was redeployed, and no active Rivals job or
lead session was migrated.

Upstream validation: 200 tests, the Python hook test, typecheck, build and package
verification passed. Clankie's focused Swarm checks passed all seven tests.
The final `pnpm check` passed: 336 test files, 2,808 tests with one skipped,
123 Rust tests, and Vox IPC smoke. An earlier run overlapped the remote CLI
source/test edits and failed one regression; the fresh focused and full runs passed.

The final release build, archive checksum, confined symlink inspection, and
packaged smoke passed. Smoke used `CLANKIE_RELEASE_SMOKE_SKIP_LAUNCHER_START=1`
because the live service owns the machine; it does not prove the owning-launcher
startup branch. Its auto-runtime assertion now matches ADR 0181: an ambient
Herdr session does not silently replace the bundled execution runtime.

## Codex and pi follow-up

The live managed Herdr provider is Claude-only: it resolves `claudePath` and
advertises `host: "claude-code"`. Codex's shipped CLI enrolls standalone sessions;
it is not wired into that managed route. The pi inline extension serves Clankie's
bound conversation, not independently hired pi workers. Neither managed-worker
canary can be claimed from this repair. The lead received these findings and owns
the requested follow-up dispatch. Global shared MCP capabilities are not a fix.
