---
name: release-clankie
description: Use when maintaining Clankie's downloadable installer or release bundle, updating bundled runtimes or assets, building a distributable artifact, or publishing a tagged GitHub Release.
---

# Release Clankie

Preserve one operator command without collapsing Clankie's process boundaries.
The macOS Apple silicon artifact contains a native launcher, a pinned Node
runtime, bundled service entrypoints and assets, and separate `herdr` and
`clankvox` processes. Herdr ownership is defined in
[`ADR 0157`](../../../docs/adr/0157-herdr-is-an-owned-runtime.md).

Read [`docs/distribution.md`](../../../docs/distribution.md),
[`ADR 0136`](../../../docs/adr/0136-a-release-is-one-command-and-one-runtime.md),
and the files being changed before editing. The active implementation lives in:

- `install.sh`
- `scripts/build-release.mjs`
- `scripts/build-herdr.mjs` and `scripts/release/herdr.json`
- `scripts/smoke-herdr.mjs`
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
  client/process boundary. Herdr is built from its pinned, checksum-verified
  fork archive, never a neighboring working tree. Keep its native license
  inventory, including libghostty-vt, in the bundle. Cloudflared and optional
  machine integrations remain external.
- Every archive contains the generated CycloneDX SBOM, dependency license
  report, and corresponding license texts. Filter Cargo metadata to the release
  target so another platform's locked dependencies do not enter the artifact.
- Version directories and published tags are immutable. Publish a correction
  under a new version; do not clobber an existing release asset.
- Retiring a subsystem is a release change. `build-release.mjs` names its
  runtime inputs as literal paths and nothing in `pnpm check` reads them, so a
  deleted directory stays green until the tag build fails. Run
  `pnpm release:build` in the same change that deletes one.

## Packaging gotchas

- Esbuild cannot see `require(...)` calls emitted later as strings by AJV. Audit
  final bundles for non-builtin runtime requires and keep only the required
  runtime package closure under the artifact's `node_modules`.
- macOS aliases `/var` as `/private/var`. Compare entrypoint paths through
  `realpath`, never by raw `import.meta.url` and `argv[1]` strings.
- A bundled import may resolve assets relative to its flattened output file.
  The captain instructions, Activity HTML, product skills under
  `.agents/skills`, `docs/cli.md`, the herdr plugin, and the Vox binary are
  runtime inputs, not development files. Checkout-only skills under
  `.agents/dev-skills` stay out of the archive. The rest of `docs/` does not
  ship.
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
compiled service, Activity asset, generated-validator runtime modules, Vox
IPC, and Herdr's native lifecycle. Use a short temporary state root: Unix
socket paths must fit macOS's 103-byte limit, including `herdr-client.sock`.
`pnpm herdr:linux:smoke` proves the native boundary in Docker; it does not prove
the complete hosted service image. If another checkout owns Clankie's singleton service, do not stop it for a
test: run the non-owning local smoke and leave the full launcher-owned branch
to a clean host or CI. Report that distinction explicitly.

Inspect the final archive rather than trusting the build command alone: verify
the launcher, Herdr, and Vox are ARM64 Mach-O files, signatures validate, metadata is
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

The viewer proof uses Python 3's stdlib PTY helper
(`scripts/smoke-herdr-viewer.py`): macOS `script` rejects Node's socket-backed
`stdio: "pipe"` with `tcgetattr/ioctl: Operation not supported on socket`.
The native `bin/clankie-herdr` alias attaches with `herdr client`; it must not
start a server. Release smoke gives it a PTY, checks the chosen workspace is
visible, detaches, and checks the worker terminal survives. Scrub inherited
`HERDR_*` for first-start private-mode smoke: auto otherwise correctly adopts
the test runner's surrounding session. After parent death, wait for the owned
native PID to exit before removing state; a closed socket alone can precede
Herdr's final session-file write.
