# Third-party notices

Vendored code:

- [`apps/vox`](apps/vox/README.md) — Clankie's recovered native media package,
  AGPL-3.0-or-later. See its [license](apps/vox/LICENSE),
  [provenance](apps/vox/PROVENANCE.md), and
  [native dependency notices](apps/vox/THIRD_PARTY_NOTICES.md).

Release-built native dependency:

- Herdr — the pinned `Volpestyle/clankie-herdr` source declares Apache-2.0.
  Its repository, commit, and archive checksum are recorded in
  [`scripts/release/herdr.json`](scripts/release/herdr.json). The release includes
  the locked Cargo graph's license texts and the vendored libghostty-vt notices.

The architecture uses or interoperates with, but does not vendor, the following projects:

- `@earendil-works/pi-tui` and Pi packages — MIT.
- Codex and Claude integrations are provider adapters. Follow each provider's current authentication, product, and distribution terms.

Every downloadable release includes `SBOM.cdx.json`,
`THIRD_PARTY_LICENSES.md`, and the license texts collected from its bundled
JavaScript and native dependency graphs. The release build fails when a bundled
dependency has no declared license or corresponding text.

This file is an engineering inventory, not legal advice.
