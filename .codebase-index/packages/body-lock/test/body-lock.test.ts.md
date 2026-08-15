# packages/body-lock/test/body-lock.test.ts

Vitest suite for the body lock, using mkdtemp
roots and injected `isAlive` so no processes are
spawned. Covers: refusing a second holder while
the first lives (and that BodyBusyError names the
holder and pid); reclaiming a dead holder's lock;
reclaiming an unparseable lock; a stale holder's
release not unlocking a reclaimed successor;
EPERM-style permission errors counting as alive;
and `observeBodyHolder` reporting the live holder,
null for dead/absent, without mutating the lock.
