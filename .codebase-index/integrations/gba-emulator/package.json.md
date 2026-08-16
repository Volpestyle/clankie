# integrations/gba-emulator/package.json

Package manifest for `@clankie/gba-emulator`.
Exports `./src/index.ts` directly (no build
step; `build` is just a typecheck).

Scripts: `test` (vitest), `fixture:check`,
`scenario:validate`, `probe:firered`,
`gameplay:live-proof`,
`gameplay:evaluate-receipt`,
`gameplay:competence`,
`gameplay:evaluate-competence-receipt`,
`free-play`. Depends on the workspace
environment-runtime / interactive-environment
/ body-lock / model-provider / protocol /
settings packages, the `ai` SDK, zod, and the
pinned `romdev-platform-gba@0.11.0` mGBA WASM
core.
