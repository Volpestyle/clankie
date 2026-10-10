# Distribution

Clankie's downloadable release is a self-contained macOS Apple silicon bundle.
It includes the native `clankie` launcher, a pinned Node runtime, compiled
service entrypoints, runtime assets, a pinned Herdr server, and `clankvox`. The operator invokes one
executable; the launcher keeps the existing process boundaries behind it.

## Install

Follow the [Mac quick start](https://docs.clankie.bot/get-started/#diy-start-on-your-mac)
for requirements, installation, local/hosted selection, and first model setup.
This reference covers the installer and runtime layout. `clankie --version`
reports the installed release.

The installer verifies the archive's published SHA-256 checksum and installs
each version immutably under `~/.local/share/clankie/releases/`. It updates
`~/.local/share/clankie/current` and links
`~/.local/bin/clankie` to the current launcher. When that directory is not on
`PATH`, it appends one `export PATH=...` line to `~/.zprofile` (zsh) or
`~/.bash_profile` (bash), so a new Terminal window finds `clankie`. Set
`CLANKIE_NO_MODIFY_PATH=1` to only print that line, and `CLANKIE_INSTALL_ROOT` or
`CLANKIE_BIN_DIR` before running the installer to choose different roots.

Both release installation and `clankie update` refresh already-linked Claude and
Codex worker plugins, including profiles on enabled SSH fleet machines, through
the existing harness installer. First-time linking still uses interactive
consent. Managed Codex profiles reuse a previously approved source-owned setup;
missing setup or an unreachable machine returns an incomplete receipt. Native
panes with an older plugin get a once-only save/restart/resume flag. Their
harnesses are never restarted by installation. See [harness linking](cli.md#linking-native-fleet-harnesses)
for receipts, source setup and manual remediation.

## Mac companion app

A Mac release with an approved `scripts/release/mac-app.json` pin installs
`Clankie.app` into `/Applications`, then opens it with the service's private
local pairing handoff. Pass `--no-app` to keep a terminal-only installation:

```sh
curl -fsSL https://clankie.bot/install | sh -s -- --no-app
```

This preference is retained for `clankie update`; rerun the installer without
`--no-app` to enable app installation. Linux releases and source-checkout
updates do not install the app. Older releases without the app helper retain
legacy behavior. To add the app when upgrading from a release whose update
helper predates companion installation, rerun `install.sh` once; subsequent
updates use the app-aware helper. `CLANKIE_APPLICATIONS_DIR` selects a different app destination
(for an owner-chosen directory or an isolated integration fixture).

The pin records `{ schemaVersion: 1, app: { version, url, sha256 } }`.
The archive is a gzip tar containing only `Clankie.app/`. The artifact is
versioned independently of the runtime; unchanged pins skip the download and
replacement. App downloads are checksum-verified before either the app or
runtime changes. Replacement stages beside the destination and retains the old
bundle until activation succeeds; a failed runtime health check also retains
the previous app. An unmanaged existing app or a symlink destination is refused.
Installation never removes app data, credentials or device identity, and never
quits a running app; it uses the new bundle on its next launch.

Pairing uses `clankie pair --local-companion`, which writes the capability only
to the existing private handoff file. It is never put in command arguments or
installer output. If the handoff or open fails, the verified app remains
installed; run that command and open the app to finish. Release-update evidence
records only `{ paired: true|false }` in `app-handoff.json`.

**Distribution remains gated:** the checked-in pin is currently `app: null`.
No companion download is enabled until VUH-1727 produces a signed, notarized,
published artifact and its approved SHA-256. This installer change does not
sign, notarize, publish or release an app. Actual first-launch redemption and
pet appearance require VUH-1833; fixture integration proves installation,
update/rollback and invocation of the private handoff, not a signed app launch.

## Updating

`clankie update` moves a release install to the latest official release; Clankie
can do the same through `update_runtime`. It verifies the archive exactly as the
installer does, unpacks it into its own `releases/vX.Y.Z`, stops the services
through the running release, switches `current`, and starts them from the new
release. The new service must report the new release's revision, or `current`
switches back and the previous release restarts. The same five-minute health
canary, status record and self-healing apply as for a source checkout
([`clankie update`](cli.md#service-lifecycle)). Already on the latest release, it
reports `upToDate` and changes nothing. `clankie update --ref vX.Y.Z` moves to a
specific release, including an older one, with an `older-than-current-pin` warning.

Install a specific release with:

```bash
curl -fsSL https://clankie.bot/install | sh -s -- --version v0.4.2
```

`https://clankie.bot/install` is a redirect to `install.sh` on this repository's
`main` (the landing site's CloudFront function), so both URLs serve the same
script.

The release binaries are ad-hoc signed. The command-line installer uses
`curl`, so the archive does not acquire a browser quarantine attribute.
Developer ID signing and notarization become necessary before distributing a
browser-downloaded package.

## Runtime layout

```text
~/.local/share/clankie/
├── current -> releases/v0.4.2
└── releases/v0.4.2/
    ├── bin/clankie
    ├── libexec/node
    ├── bin/clankie-herdr      # attach-only viewer shortcut
    ├── libexec/herdr          # Clankie-owned native worker runtime
    ├── libexec/local-fleet-proof # macOS kernel socket/process observer
    ├── packages/fleet-resources/src/native.py # shared resource lock/process runner
    ├── .agents/skills/        # product and working skills
    ├── docs/cli.md            # headless command contract
    ├── apps/                  # bundled services, assets, and clankvox
    ├── integrations/          # game runtime assets and the optional herdr plugin
    ├── SBOM.cdx.json
    └── THIRD_PARTY_LICENSES.md
```

Mutable process records, logs, and TUI history live under
`${XDG_STATE_HOME:-~/.local/state}/clankie`, outside the release. Owner settings
and broker-backed credentials remain in their documented user-level homes.
An interactive console resumes the existing main conversation regardless of
its launch directory. Tools use the selected conversation's workspace; select
a project with `/cd PATH` or a retained conversation with `--chat ID`.
Supervised services run from their installed release root.

macOS releases include an ad-hoc signed `local-fleet-proof` helper, built against
the system `libproc`. Local fleet admission calls it directly; installed users
need no compiler. Source-checkout `dev` and `start` prepare its build under
`.local/fleet-proof/` before starting the body. `pnpm fleet-proof:build` prepares
the same artifact explicitly, reusing it only when its source, architecture,
compiler flags and binary digest match. Missing or unsupported native observation
refuses local admission; it never falls back to an expensive socket scan.

The shared fleet resource governor also ships `packages/fleet-resources/src/native.py`.
It uses Python 3's standard library for kernel file locks, process birth observations
and command groups; macOS uses `/usr/bin/python3`, Linux uses `python3` on PATH.
The hosted Linux image installs that interpreter. For self-hosted installations
it is an explicit host prerequisite. A missing interpreter or helper
refuses new heavy work and local builders without taking `/health` down. The
helper path is resolved from the source or installed release, not a worker override.
The journal lives in the OS account's `~/.clankie/fleet-resources` across releases
and worktrees. See [resource commands](cli.md#fleet-resource-governor).

Herdr ships as an official stable release binary, verified against the
platform checksum in `scripts/release/herdr.json`. Its matching source archive
is retained for license inventory; no fork or Rust/Zig build is needed for Herdr.
The build generates the bundled `herdr` skill directly from that executable's
`--skill` output, including both Claude plugin copies. `pnpm herdr:skill` refreshes
the checkout copy from the same checksum-verified pin; `pnpm check` rejects drift.
The hosted image verifies the skill bytes and pinned version as its runtime user,
so a fresh body needs no globally installed Herdr skill.
The service checks `https://herdr.dev/latest.json` at startup and every six hours,
staging verified releases outside the immutable install. Live workers keep a
matching server/CLI copy. Staged releases apply when Clankie's own fleet starts
with no existing server; restarting Clankie alone leaves a live fleet intact.
Offline starts use the last verified cached release or the official packaged
fallback. See [ADR 0172](adr/0172-herdr-sessions-follow-official-releases.md).
The service owns its headless process and private state under
`$CLANKIE_STATE/herdr` (default `~/.clankie/herdr`), with health and crash
recovery through a child supervisor. See [ADR 0157](adr/0157-herdr-is-an-owned-runtime.md).
Runtime selection follows saved settings, independent of the launch terminal
([ADR 0181](adr/0181-clankie-is-independent-of-his-connections.md)). Current
binding and fallback behavior live in [the CLI reference](cli.md#herdr-statusopencreate--herdr-use-name).
Source checkouts download the official release on first use; `pnpm herdr:build`
prepares the pinned offline fallback and license source. `clankie herdr use NAME`
selects an existing session; `clankie herdr create` selects Clankie’s own.
Restart Clankie to apply. `clankie-herdr` opens the running fleet without owning its lifetime.
The Clankie TUI works inside vanilla Herdr in either distribution.

Browser Use Pi ships with its JavaScript worker and dependency graph intact;
the worker is launched from a sibling file and cannot be flattened into the
service bundle. Chrome and FFmpeg remain external executables. Set
`CLANKIE_RELEASE_SMOKE_BROWSER=1` to exercise the packaged SDK against local
Chrome during release smoke.
The hosted build preserves relative dependency symlinks when moving the assembled
release and imports Browser Use Pi from its final image location as the runtime
user. This catches broken package links before an image can pass its build.

Optional integrations such as cloudflared remain external executables.
The Minecraft MCP motor ships as its own compiled entrypoint under
`integrations/minecraft-mcp`, with Mineflayer, version data and browser viewer
assets in their normal package layout. It joins lazily through an approved
profile. Chrome remains external; the renderer avoids native canvas/GL builds.
Clankie's own herdr plugin declaration ships under
`integrations/herdr-plugin` so it can be linked without a git checkout.
`clankie doctor` reports whether this tree is a release or a checkout, which
models and credentials are configured, and whether those optional commands
are on PATH. The headless command contract is
[`docs/cli.md`](cli.md) (`clankie help` prints the same index). Checkout-only
skills under `.agents/dev-skills` stay out of the archive. The release also
ships `docs/bundled-skills.md`, the pinned process-skill manifest and MIT license,
`docs/worker-access.md`, `docs/model-keys.md`, `docs/rivals.md`,
`docs/discord-ingress.md`, `docs/minecraft.md` and
`infra/hosted/README.md` for the installed skills' operational references.
Other repository documentation does not ship.

The public gateway is Clankie's hosted service, not part of the Mac release;
its source, Cognito accounts, and deployment live in the private `clankie-ops`
repository ([ADR 0183](adr/0183-the-harness-is-public-the-hosted-service-is-private.md)).
The release contains the outbound connector, passwordless `/gateway` setup
wizard, and launch-at-login command. Tailscale remains an optional direct
development lane and is not required by an App Store client.

Public documentation lives in [`apps/docs`](../apps/docs/README.md) and
deploys to [`docs.clankie.bot`](https://docs.clankie.bot) from `main`: setup,
how he works, and the console, CLI, HTTP API, and network references rendered
from this repository's canonical files at build time. It links the landing
site's canonical App Store privacy and support pages. The docs site is separate
from the Mac release and reuses its existing private S3 and CloudFront hosting.

## Build and release

On an Apple silicon Mac with the [repository toolchain](../CONTRIBUTING.md):

```bash
pnpm release:build
pnpm release:smoke
pnpm check:load
```

The build writes `dist/clankie-darwin-arm64.tar.gz` and its checksum. It fails
unless bundled JavaScript and reachable Cargo dependencies have declared
licenses and included license text. The smoke test extracts the archive outside
the checkout and exercises its launcher, service, Activity assets, Vox IPC,
and native Herdr worker execution, session restoration, crash recovery, and cleanup.
Shared provider registration includes Pi's static OAuth flows in the bundle;
`apps/tui/test/packaged-oauth.test.ts` checks auth derivation outside the checkout.

`pnpm herdr:linux:smoke` builds and exercises the same pinned Herdr runtime
inside Docker. `pnpm hosted:build` builds the single-owner Linux captain,
native Herdr worker and relay image; `pnpm hosted:smoke` checks isolated execution
and persistence. The [hosted deployment guide](../infra/hosted/README.md) owns
setup, supported capabilities and remaining managed-hosting requirements.

Pushing a version tag matching `package.json` (for example `v0.4.2`) runs the
full repository check and fleet load gate, builds and smoke-tests the archive on an Apple silicon
GitHub runner, builds the `linux-arm64` and `linux-x64` archives that hosted bodies
install ([ADR 0237](adr/0237-hosted-bodies-update-themselves-to-official-releases.md)),
and uploads all three archives with their checksums to the matching GitHub Release.
