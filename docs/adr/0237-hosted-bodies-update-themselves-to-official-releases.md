# ADR 0237: Hosted bodies update themselves to official releases

Status: Accepted (2026-10-06). Amends the hosted-image rule in commit `05f17fd1`
("hosted images never update themselves"). Builds on
[ADR 0183](0183-the-harness-is-public-the-hosted-service-is-private.md) and
[ADR 0055](0055-launcher-owned-local-services.md).

## Decision

A hosted body (managed or self-run) installs official Clankie releases itself,
with the same mechanism a Mac release install uses: download the verified
archive, stage it beside the running release, switch `current`, health-check the
new services and switch back if they do not come up. Source checkouts keep
following `origin/main`; this decision changes only release installs.

1. **Linux release archives.** Every official release publishes
   `clankie-linux-arm64.tar.gz` and `clankie-linux-x64.tar.gz` with `.sha256`
   files beside the macOS archive, built by `scripts/build-release.mjs --hosted`.
   `release.json` records its `target`; the updater only accepts an archive for
   its own target.
2. **A writable release root.** The image's `/opt/clankie` becomes the seed, not
   the running install. On boot the entrypoint seeds
   `/state/releases/<version>` from it when absent and points
   `/state/releases/current` at the newer of the seed and the current release,
   so a new image (base or OS update) is never shadowed by an older self-installed
   release. The launcher and service run from `current`.
3. **Private provider compatibility.** A managed image installs its runtime
   provider outside the replaced tree. `RuntimeProvider` declares the provider
   API version it implements and `release.json` declares the version a release
   expects. The updater refuses (`provider-api-unsupported`) a release the
   installed provider cannot serve, so an update never silently drops managed
   model, quota or credit policy.
4. **One fleet-wide brake.** A managed body asks the fleet for its approved
   release (a signed `POST /fleet/v1/body/release`, like every body route) and
   installs nothing newer. `null` holds every body in place; an unreachable or
   refused answer installs nothing. A self-run body (no hosted bootstrap) follows
   the latest official release.
5. **When it runs.** Hosted bodies check on a schedule and on request
   (`update_runtime`, `clankie update`). A scheduled install waits until the body
   is idle: no running captain turn, voice session or hired worker. Owners can
   turn scheduled installs off (`clankie update auto off`, `/update` in the TUI);
   managed bodies keep them on.

## Why

A control-plane rollout (building a tenant image per release, replacing every
body's root volume in batches, promoting the launch template) needs automated
authority over images, instances and the production tenant stack, plus cleanup
of a retained root volume per body per release. The body already has a release
updater with per-body health rollback; hosted only lacked Linux archives, a
writable install and a way to keep private policy compatible. "Hosted Clankie
just works" then holds without new infrastructure: bodies stay current and
nobody runs a deploy for an ordinary release.

Per-body rollback catches a release that fails health checks, not one that is
broken some other way on every body. The approved-release answer is the single
stop for that case, and lets the control plane stage releases by cohort later
without the body changing.

## Alternatives

- **Control-plane rollout per release** (the staged root replacement): kept for
  base-image and OS changes, rejected for every code release for the authority
  and cost above.
- **No hosted updates; owners rebuild images**: contradicts hosted just working
  and leaves managed bodies stale between operator deploys.
- **Writable `/opt/clankie`**: mixes image-owned files with installed releases
  and loses the seed a new image provides.

## Consequences

- Official releases build and publish three archives; a release missing one
  target leaves those bodies on their current version.
- `/state` holds up to two releases (current and the previous one kept for
  rollback); older ones are removed after a successful switch.
- A managed provider that lags a release's provider API holds those bodies
  until a compatible provider image ships.
- The release archive's checksum comes from the same official GitHub release,
  as on macOS. A compromised release publisher reaches hosted bodies too.
- The public half (archives, release root, provider API check, approved-release
  cap, idle scheduling) lives here; the managed provider location and the fleet
  route live in the private hosted service.
