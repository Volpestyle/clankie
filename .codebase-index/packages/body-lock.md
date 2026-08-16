# packages/body-lock

Cross-process mutex for the GBA emulator body:
exactly one writer may drive the body at a time,
enforced by a lockfile in the shared body root.
Exists because `EnvironmentRuntime`'s in-memory
one-writer rule cannot see across the free-play
CLI, the live activity run, and the MCP server —
three separate processes (ADR 0053).

Children:

- `package.json` — @clankie/body-lock manifest
- `src/` — the single-module implementation
- `test/` — lockfile contention/reclaim tests
- `tsconfig.json` — standard noEmit config

Key ideas:

- Atomic `openSync(path, "wx")` creation is the
  mutual exclusion; no check-then-write race.
- Liveness, not time: a lock whose pid is dead
  (`kill(pid, 0)`) is reclaimed, so a crash never
  bricks the body. EPERM counts as alive.
- Grants no authority — the runtime's lease still
  governs what the holder may do; this only decides
  who gets to be the holder.
- `observeBodyHolder` gives observability planes a
  read-only view (VUH-938) without touching the
  lock, keeping environment bodies out of the
  captain's hands (ADR 0063 fence).
- `defaultGbaBodyRootDir` resolves the shared
  directory (CLANKIE_GBA_BODY_ROOT override,
  else XDG state home) that scopes the rule.

Depends only on zod. Machine-local by design —
the body is local hardware.
