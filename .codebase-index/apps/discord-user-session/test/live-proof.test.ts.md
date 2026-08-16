# apps/discord-user-session/test/live-proof.test.ts

Tests the stream-watch live-proof gate. Passing evidence requires a decoded still newer than the matching watch for the same user; listing alone, stale frames, and cross-user frames remain incomplete.
