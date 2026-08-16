# scenarios/minecraft/README.md

Explains the frozen Minecraft scenario
discipline for collect-craft-place/v1: exact
scenario.yml bytes hashed in scenario.sha256,
verified before the Paper plugin compiles, and
embedded in the plugin JAR; server.properties
separately hashed so the seed/network policy
cannot drift.

Key points: the acting gameplay lane never
receives the console-only verifier lifecycle
command or fixture-rewriting filesystem access;
scenario.yml is exempt from repo formatting
(bytes are identity); the pinned server is
loopback-only, offline-mode, whitelisted, flat —
laboratory-only (real account/server setup is
VUH-779's, not implied here); and the reset
surface is deliberately bounded (player state,
eight log blocks, the crafting-table target
cuboid) so the same seed reproduces the same
relevant-state hash without treating the whole
world as an acceptance artifact.
