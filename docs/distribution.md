# Distribution

Clankie's downloadable release is a self-contained macOS Apple silicon bundle.
It includes the native `clankie` launcher, a pinned Node runtime, compiled
service entrypoints, runtime assets, and `clankvox`. The operator invokes one
executable; the launcher keeps the existing process boundaries behind it.

## Install

The release supports macOS 14 or newer on Apple silicon.

```bash
curl -fsSL https://raw.githubusercontent.com/Volpestyle/clankie/main/install.sh | sh
clankie --version
clankie
```

The installer verifies the archive's published SHA-256 checksum and installs
each version immutably under `~/.local/share/clankie/releases/`. It updates
`~/.local/share/clankie/current` and links
`~/.local/bin/clankie` to the current launcher. Set `CLANKIE_INSTALL_ROOT` or
`CLANKIE_BIN_DIR` before running the installer to choose different roots.

Install a specific release with:

```bash
curl -fsSL https://raw.githubusercontent.com/Volpestyle/clankie/main/install.sh | sh -s -- --version v0.2.0
```

The release binaries are ad-hoc signed. The command-line installer uses
`curl`, so the archive does not acquire a browser quarantine attribute.
Developer ID signing and notarization become necessary before distributing a
browser-downloaded package.

## Runtime layout

```text
~/.local/share/clankie/
├── current -> releases/v0.2.0
└── releases/v0.2.0/
    ├── bin/clankie
    ├── libexec/node
    ├── .agents/skills/        # product skills (this-machine, trace-clankie)
    ├── docs/cli.md            # headless command contract
    ├── apps/                  # bundled services, assets, and clankvox
    ├── integrations/          # game runtime assets and the optional herdr plugin
    ├── SBOM.cdx.json
    └── THIRD_PARTY_LICENSES.md
```

Mutable process records, logs, and TUI history live under
`${XDG_STATE_HOME:-~/.local/state}/clankie`, outside the release. Owner settings
and broker-backed credentials remain in their documented user-level homes.
The working directory of an interactive Clankie conversation is the directory
where the operator invokes `clankie`; supervised services run from their
installed release root.

Optional machine integrations such as Herdr, cloudflared, and external browser
tools remain external executables. The release does not copy their code or
licenses. Clankie's own herdr plugin declaration ships under
`integrations/herdr-plugin` so it can be linked without a git checkout.
`clankie doctor` reports whether this tree is a release or a checkout, which
models and credentials are configured, and whether those optional commands
are on PATH. The headless command contract is
[`docs/cli.md`](cli.md) (`clankie help` prints the same index). Checkout-only
skills under `.agents/dev-skills` stay out of the archive. The rest of
`docs/` does not ship.

The AWS public gateway is a separate deployment, not part of the Mac release.
The release contains the outbound connector and `/gateway` setup wizard; the
single-instance Lightsail/Caddy deployment procedure lives under
[`infra/aws/public-gateway`](../infra/aws/public-gateway/README.md). The
[public gateway launch gate](public-gateway-launch.md) joins hosting,
user-perceived metrics, scaling triggers, and the App Store review journey.
Tailscale remains an optional direct development lane and is not required by an
App Store client.

## Build and release

On an Apple silicon Mac with the repository toolchain installed:

```bash
pnpm release:build
pnpm release:smoke
```

The build writes `dist/clankie-darwin-arm64.tar.gz` and its checksum. It fails
unless bundled JavaScript and reachable Cargo dependencies have declared
licenses and included license text. The smoke test extracts the archive outside
the checkout and exercises its launcher, service, Activity assets, and Vox IPC.

Pushing a version tag matching `package.json` (for example `v0.2.0`) runs the
full repository check, builds and smoke-tests the archive on an Apple silicon
GitHub runner, and uploads both assets to the matching GitHub Release.
