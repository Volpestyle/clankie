# Third-party notices

Vendored code:

- [`apps/vox`](apps/vox/README.md) — Clankie's recovered native media package,
  AGPL-3.0-or-later. See its [license](apps/vox/LICENSE),
  [provenance](apps/vox/PROVENANCE.md), and
  [native dependency notices](apps/vox/THIRD_PARTY_NOTICES.md).

The architecture uses or interoperates with, but does not vendor, the following projects:

- `@earendil-works/pi-tui` and Pi packages — MIT.
- Herdr — review its current AGPL/commercial terms before bundling or copying code. Treat it as an optional external agent-pane host unless counsel approves another arrangement.
- Codex and Claude integrations are provider adapters. Follow each provider's current authentication, product, and distribution terms.

Every downloadable release includes `SBOM.cdx.json`,
`THIRD_PARTY_LICENSES.md`, and the license texts collected from its bundled
JavaScript and native dependency graphs. The release build fails when a bundled
dependency has no declared license or corresponding text.

This file is an engineering inventory, not legal advice.
