# apps/discord-bridge/test/possessor-text.test.ts

Tests text forwarded from a Discord room to the active play possessor. Ingress allowlists are reused exactly, unaddressed speech is admitted, empty text is ignored, and overlong lines are truncated at the seam.
