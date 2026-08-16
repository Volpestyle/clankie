# integrations/gba-emulator

Governed, local-only GBA embodiment for FireRed and Emerald. It drives pinned mGBA cores or a deterministic test double through `EnvironmentRuntime`, validates bounded GBA contracts, publishes frames and play evidence, and keeps operator ROM/savestate bytes outside the repository.

- `fixtures/` — pinned scenario identities and ROM-free test samples.
- `package.json` — emulator scripts and dependencies.
- `README.md` — core, decoder, scenario, free-play, and evidence guide.
- `scripts/` — bootstrap, probe, and live-proof utilities.
- `src/` — cores, adapter, decoder, scenarios, free play, and checkpoints.
- `test/` — deterministic and optional ROM-gated tests.
- `tsconfig.json` — TypeScript configuration.
