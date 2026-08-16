# Vox provenance

`apps/vox` preserves the ClankVox media plane from the previous Clankie
monorepo.

- Source repository: `Volpestyle/clankie-old`
- Base source commit: `04734df9ec1ec4665a233c4c64f0a51a9d3b0b83`
- Source path: `clankvox/`
- Base source tree: `11f24ddcfc3ee62d45b83638e788877f39cd8fdc`
- Recovered working-tree patch SHA-256:
  `73592adcd0d0931a2b37ca9c6029473eecb851208ec8c3d1c8fc9e306da71e19`
- Additional legacy commit: `be78f5c3e38dec7bb87c0923043178593e3b3895`
  (`Refactor ClankVox handshake receive loop`)
- Imported package version: `0.3.0`
- License: `AGPL-3.0-or-later`

## Current modifications

The package is adapted in this repository on 2026-08-15:

- moved from `clankvox/` to `apps/vox/` and wrapped as `@clankie/vox`;
- applies the recovered four-file Go Live DAVE patch described below;
- includes the legacy handshake cleanup commit that had not reached master;
- removes the obsolete standalone docs app, nested lockfile, and nested skills;
- builds and tests through the root pnpm/Turbo/CI graph;
- exposes IPC through the separate Apache-2.0 `@clankie/vox-client` package;
- updates package, architecture, licensing, and operational documentation.

The recovered patch updates `davey` to 0.1.4 and carries the Go Live
per-packet DAVE decrypt fix across `Cargo.toml`, `Cargo.lock`,
`docs/go-live.md`, and `src/voice_conn/udp_rx.rs`. It was present in the source
checkout but not committed to the base repository, so its digest is recorded
explicitly rather than attributing it to the base tree.

The standalone documentation application and nested package-manager files are
not part of the runtime package. The transport source, Cargo lockfile, media
documentation, and package license are preserved here.
