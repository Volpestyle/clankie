# Frozen Minecraft scenarios

`collect-craft-place/v1` is the first server-authoritative scenario. Its exact
`scenario.yml` bytes are hashed in `scenario.sha256`, checked before the Paper
plugin compiles, and embedded in the plugin JAR. `server.properties` has its own
checked hash so the private seed/network policy cannot drift. The acting gameplay lane never
receives the console-only verifier lifecycle command or a filesystem capability
that can rewrite the fixture, plugin, or result.

The matching `server.properties` pins a private loopback, offline, whitelisted,
flat Paper world. Offline mode is laboratory-only; real account/server setup is
owned by VUH-779 and is not implied by this fixture.

The reset surface is deliberately bounded: player state, eight log blocks, and
the crafting-table target cuboid. Resetting the same seed and fixture produces
the same relevant-state hash without treating the entire generated world as an
acceptance artifact.
