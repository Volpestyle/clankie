# ADR 0008: Symlinked provider skill mirror

Status: accepted.

`.agents/skills` is the single source of truth for load-on-demand skills. Each provider harness reads from its own root (`.claude/skills`, `.codex/skills`, `.pi/agent/skills`), so those roots must present the same skills.

They mirror the canonical directory with relative symlinks, not copies. Copies drift: a direct edit to a provider copy survives until the next `pnpm skills:sync` silently overwrites it, and every skill change lands in git as an N× diff across all roots. Symlinks make the provider paths _be_ the canonical files, so drift is structurally impossible and only one tree is versioned.

`pnpm skills:sync` creates and repairs the symlinks (add a skill under `.agents/skills`, run it to wire the mirrors and prune stale links). `pnpm skills:check` — part of `pnpm check` — verifies every mirror is the correct relative symlink and fails otherwise, so `check` never mutates the tree. The architecture check no longer hashes the mirror trees; that invariant lives in `skills:check`, and a tree walk that hashed through symlinks would fault.

`apps/captain-eve/agent/skills` is a distinct, single-copy skill set and is out of scope for this mirror.
