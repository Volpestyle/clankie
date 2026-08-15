# integrations

Clankie's game-world bodies: two workspace
packages that implement the
`EnvironmentAdapter` interface from
`@clankie/environment-runtime`, so every game
action inherits the runtime's leases,
idempotency, pause/cancel, and emergency-stop
fencing.

Children:

- `gba-emulator` — Pokémon FireRed/Emerald via
  a pinned headless mGBA WASM core; decoded RAM
  state, model-driven free play, deterministic
  scenario proofs, checkpoints.
- `minecraft-mineflayer` — Minecraft Java via
  Mineflayer against a loopback-only private
  Paper server; bounded observe / navigate /
  collect / craft / place motor.

Both packages are contract-first: strict zod
schemas from `@clankie/interactive-environment`
validate every command and observation, all
identities (ROMs, savestates, server jars) are
pinned by SHA-256 and fail closed on mismatch,
and copyrighted or operator-local bytes never
enter the repo — only digests do.
