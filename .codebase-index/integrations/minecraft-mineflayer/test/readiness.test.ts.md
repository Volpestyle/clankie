# integrations/minecraft-mineflayer/test/readiness.test.ts

Tests `inspectMinecraftLiveReadiness` against
a temp JDK-21 shim and a synthetic jar: a
fully ready environment passes all checks; a
mismatched Paper pin and unacknowledged EULA
report the right missing inputs — and the
serialized receipt never exposes local paths.
