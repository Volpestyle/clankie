# scenarios/minecraft

Frozen server-authoritative Minecraft scenarios.
Holds a README on the freeze discipline and one
scenario, collect-craft-place/v1: a Paper-server
verification fixture whose scenario.yml bytes are
hashed in scenario.sha256, checked before the
Paper verifier plugin compiles, and embedded in
the plugin JAR. server.properties has its own
pinned hash so the private loopback/offline/
whitelist policy cannot drift.

The acting gameplay lane never gets the
console-only verifier lifecycle command or a
filesystem capability that could rewrite fixture,
plugin, or result. scenario.yml is excluded from
repo-wide formatting — its exact bytes are the
scenario identity.
