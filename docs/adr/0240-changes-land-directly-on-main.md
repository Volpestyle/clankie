# ADR 0240: Changes land directly on main

Status: Accepted (James, 2026-10-07). Retires the mandatory landing queue in
[integration](../integration.md); `clankie integrate` remains an optional tool.

## Context

Every clankie and clankie-app landing was required to go through
`clankie integrate`, which composed a batch and ran the full `pnpm check`
before pushing `main`. By 2026-10-07 none of the 15 recorded batches had
landed: seven failed their gate, five conflicted, and the rest waited 20–80
minutes for shared heavy-check slots. A batch with no commits failed too,
because `main` itself fails the full suite (137 of 7,211 tests). Meanwhile 228
commits reached `main` directly, so the queue guarded nothing while delaying
every change that obeyed it. A full suite per landing also contradicts the
owner's standing rule that per-change checks stay fast and narrow, with full
suites for releases and explicit manual runs.

## Decision

Agents and the owner commit to `main` and push it directly:

1. Stage only your own files.
2. Run the narrow checks for what you changed: formatting, typecheck, and the
   tests that cover the change (through `clankie heavy --` on this Mac).
3. `git pull --rebase origin main`, then `git push origin main`. Resolve
   conflicts only in your own files; coordinate with the owner of the rest.

The full `pnpm check` runs for releases and on request. `clankie integrate`
stays available for anyone who wants a composed, gated batch, but nothing
requires it, and the direct-main pre-push guard is no longer offered as policy.

## Consequences

- Fixes reach `main` minutes after their narrow checks pass.
- A change that breaks something outside its own checks is not caught until a
  release or manual full run. Restoring a green full suite is separate work.
- Concurrent agents in a shared checkout must commit only their own files and
  rebase before pushing; a separate worktree avoids disturbing others'
  uncommitted work.
