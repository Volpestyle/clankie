# packages/body-lock/src/index.ts

The entire body-lock package: a lockfile mutex
ensuring one writer for the emulator body across
processes (ADR 0053), plus a read-only observer
and the shared body-root resolver.

Exports:

- `acquireBodyLock({rootDir, holderId, pid?, ...})`
  → `BodyLock` with `holder`, `lockPath`,
  `release()`. Throws `BodyBusyError` (carries the
  live holder, names who to stop) when held.
- `observeBodyHolder(rootDir)` — who holds the body
  now, or null; never mutates the lock (VUH-938).
- `defaultGbaBodyRootDir(env?)` — resolves and
  mkdirs the shared state dir: CLANKIE_GBA_BODY_ROOT
  or `$XDG_STATE_HOME/clankie/gba-body`.
- `BODY_LOCK_FILENAME` ("body.lock"),
  `BodyLockHolder` (zod-validated {pid, holderId,
  acquiredAt}).

Implementation notes:

- Exclusive create (`"wx"`) is the mutex; on
  EEXIST it reads the holder, reclaims when the
  pid is dead (`kill(pid,0)`; EPERM = alive) or the
  file is unparseable, and retries once.
- `release()` only unlinks a lock still owned by
  this holder (pid + acquiredAt match), so a stale
  holder's cleanup cannot unlock a successor.
- `isAlive`/`now`/`pid` are injectable for tests.
