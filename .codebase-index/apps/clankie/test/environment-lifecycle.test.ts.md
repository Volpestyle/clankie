# apps/clankie/test/environment-lifecycle.test.ts

Composition tests for the environment lifecycle
factories: the Minecraft and GBA bodies land
behind `EnvironmentRuntime` with the right
adapter types, and GBA frame publishing only
ships with a sink configured, keeping the
stream's dedupe state across calls (identical
frames dropped, changed frames shipped with
monotonic sequence).
