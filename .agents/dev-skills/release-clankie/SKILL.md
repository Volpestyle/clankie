---
name: release-clankie
description: Use when maintaining Clankie's downloadable installer or release bundle, updating bundled runtimes or assets, building a distributable artifact, or publishing a tagged GitHub Release.
---

# Release Clankie

Preserve one operator command without collapsing Clankie's process boundaries.
The macOS Apple silicon artifact contains a native launcher, a pinned Node
runtime, bundled service entrypoints and assets, and the separate `clankvox`
process.

Read [`docs/distribution.md`](../../../docs/distribution.md),
[`ADR 0136`](../../../docs/adr/0136-a-release-is-one-command-and-one-runtime.md),
and the files being changed before editing. The active implementation lives in:

- `install.sh`
- `scripts/build-release.mjs`
- `scripts/smoke-release.mjs`
- `scripts/release/clankie-launcher.c`
- `.github/workflows/release.yml`

## Invariants

- Keep the artifact's repository-shaped paths. Bundled code derives runtime
  roots from `import.meta`, and flattening the tree silently breaks assets and
  native children.
- Interactive conversations use the directory where the operator invokes
  `clankie`. Supervised services use the installed release root. Mutable state,
  settings, and credentials stay outside immutable release directories.
- A source checkout continues to launch workspace services through pnpm. An
  installed release uses `libexec/node` and compiled `.js` entrypoints. Require
  both the bundled Node binary and entrypoint before selecting the installed
  path.
- `clankvox` remains a separately licensed AGPL executable behind the Apache
  client/process boundary. Do not bundle Herdr, cloudflared, or optional
  machine integrations.
- Every archive contains the generated CycloneDX SBOM, dependency license
  report, and corresponding license texts. Filter Cargo metadata to the release
  target so another platform's locked dependencies do not enter the artifact.
- Version directories and published tags are immutable. Publish a correction
  under a new version; do not clobber an existing release asset.

## Packaging gotchas

- Esbuild cannot see `require(...)` calls emitted later as strings by AJV. Audit
  final bundles for non-builtin runtime requires and keep only the required
  runtime package closure under the artifact's `node_modules`.
- macOS aliases `/var` as `/private/var`. Compare entrypoint paths through
  `realpath`, never by raw `import.meta.url` and `argv[1]` strings.
- A bundled import may resolve assets relative to its flattened output file.
  The captain instructions, Activity HTML, GBA fixtures/scenarios, mGBA glue
  and Wasm, product skills under `.agents/skills`, the herdr plugin, and Vox
  binary are runtime inputs, not development files. Checkout-only skills under
  `.agents/dev-skills` stay out of the archive.
- The Node version and its official checksum source are owned by
  `scripts/build-release.mjs`. Update the pin deliberately and prove the new
  runtime with a rebuilt archive.

## Maintain or update

Make the smallest change in the owner above, update distribution docs and ADRs
when the contract changes, then run:

```bash
pnpm check
pnpm release:build
pnpm release:smoke
(cd dist && shasum -a 256 -c clankie-darwin-arm64.tar.gz.sha256)
```

The smoke must extract outside the checkout and exercise the native launcher,
compiled service, Activity asset, generated-validator runtime modules, and Vox
IPC. If another checkout owns Clankie's singleton service, do not stop it for a
test: run the non-owning local smoke and leave the full launcher-owned branch
to a clean host or CI. Report that distinction explicitly.

Inspect the final archive rather than trusting the build command alone: verify
the launcher and Vox are ARM64 Mach-O files, signatures validate, metadata is
present, the checksum passes, and no symlink escapes the release tree.

## Publish

Publishing changes external state. Do not commit, tag, push, create a GitHub
Release, or replace an installed version unless the user explicitly authorizes
that action.

When authorized, require a clean, committed release change and a tag exactly
matching `v` plus the root `package.json` version. Push the new tag once. Watch
the Release workflow through completion, verify both uploaded assets and their
checksum, then test the documented installer against that published version.
Never weaken or skip the workflow's repository gate to make a release pass.

Developer ID signing, notarization, Intel macOS, Linux, package-manager
formulas, and a browser-downloaded installer remain separate targets until the
project deliberately adopts those distribution channels.
