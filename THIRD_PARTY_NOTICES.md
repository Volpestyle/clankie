# Third-party notices

Vendored code and instructions:

- [Opinionated process skills](vendor/opinionated-skills.json) — MIT, authored in
  Volpestyle/skills. The snapshot retains [its license](vendor/opinionated-skills/LICENSE);
  downloadable releases include it as `licenses/opinionated-skills-MIT.txt`.

- [`apps/vox`](apps/vox/README.md) — Clankie's recovered native media package,
  AGPL-3.0-or-later. See its [license](apps/vox/LICENSE),
  [provenance](apps/vox/PROVENANCE.md), and
  [native dependency notices](apps/vox/THIRD_PARTY_NOTICES.md).

Bundled native dependency:

- Herdr — an official release binary from `herdrdev/herdr`. Its repository,
  release tag, platform binary checksums, and matching source-archive checksum
  are recorded in [`scripts/release/herdr.json`](scripts/release/herdr.json).
  Release assembly retains that source for the locked Cargo license inventory
  and vendored libghostty-vt notices; it does not build the retired Clankie fork.

The architecture uses or interoperates with, but does not vendor, the following projects:

- `@earendil-works/pi-tui` and Pi packages — MIT.
- Codex and Claude integrations are provider adapters. Follow each provider's current authentication, product, and distribution terms.

Every downloadable release includes `SBOM.cdx.json`,
`THIRD_PARTY_LICENSES.md`, and the license texts collected from its bundled
JavaScript and native dependency graphs. The release build fails when a bundled
dependency has no declared license or corresponding text.

This file is an engineering inventory, not legal advice.
