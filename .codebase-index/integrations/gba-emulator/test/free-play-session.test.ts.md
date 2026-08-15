# integrations/gba-emulator/test/free-play-session.test.ts

Tests the session composition: a second writer
on the same body root is refused
(cross-process body lock — the whole point of
one stable root), `defaultGbaBodyRootDir`
resolves consistently with env overrides,
per-run session ids keep runs as separate
records, and lease renewal survives thinking
between moves.
