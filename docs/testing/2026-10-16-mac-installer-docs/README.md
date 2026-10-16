# Mac installer docs and isolated published install — VUH-1730

Tracks [VUH-1730](https://linear.app/vuhlp/issue/VUH-1730), including the folded
VUH-1734 docs. The public README, quick start, docs home and clankie.bot explain
the approved Mac release's `/Applications/Clankie.app` destination and
`--no-app`. The app README and version lanes describe the same contract.
They also state the current limit: the signed companion artifact is not
published, so today's installer supplies the terminal bundle only.

## Published installer proof

On 2026-10-16, the real public installer installed published **v0.4.4** into
an empty custom prefix with a fresh HOME and throwaway Applications directory.
No fixture archive, curl replacement, app stub or local release build was used.

- Downloaded `https://clankie.bot/install`; its SHA-256 was
  `c6451425be8f369931d7f60612a57be32f5b7f272947a6e32101232a91e8ff11`,
  identical to this checkout's `install.sh`.
- Downloaded the official `clankie-darwin-arm64.tar.gz` from release v0.4.4.
  Its published checksum passed:
  `bfa45794f3c7b1022d815bc2331caa44afd19bdf4d2616a80d42238dabd11281`.
- Inspected the verified archive before installation: its app pin is
  `{ "schemaVersion": 1, "app": null }`, matching current main.
- Ran the public script with `--version v0.4.4`, **without `--no-app`**.
  `HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `CLANKIE_INSTALL_ROOT`,
  `CLANKIE_BIN_DIR`, `CLANKIE_APPLICATIONS_DIR` and `TMPDIR` all named owned
  disposable paths. `CLANKIE_NO_MODIFY_PATH=1` prevented shell profile edits;
  inherited Claude/Codex and Clankie state/settings overrides were removed.
  The install ran through `clankie heavy --`.
- Exit 0. Output included `Clankie.app skipped (opt-out or no published pin).`
  The stored app policy was `{ "disabled": false }`, confirming this was the
  default app-enabled path. The runtime's `current` and launcher links pointed
  to the verified v0.4.4 installation. Harness linking was explicitly skipped
  because the prefix was non-default.
- The fresh HOME and throwaway Applications directory remained empty. No app,
  service, pairing flow or GUI was launched. James's installed app and
  `~/dev/clankie` were not used or changed.

This proves the published terminal install and its honest no-artifact behavior.
It does **not** prove an app was written to `/Applications`, a paired pet, or a
clean macOS user. Changing HOME does not isolate the logged-in user's Keychain
or GUI session.

## Remaining acceptance criterion

The clean-Mac, paired-pet criterion remains open, blocked on
[VUH-1727](https://linear.app/vuhlp/issue/VUH-1727): an approved Developer ID
signed, notarized app archive, its published URL and SHA-256, and a release
carrying that pin. No clean machine can install the companion while the pin
is null.

After that artifact ships, run the default public installer on a clean Mac or
an explicitly prepared disposable macOS GUI user with a separate Keychain.
Verify `/Applications/Clankie.app`, successful Gatekeeper assessment, first
launch with a paired desktop pet, and restore after relaunch. A custom
Applications prefix can establish installation without replacing an owner's
app, but cannot establish the default `/Applications` destination.

Existing narrower evidence remains useful: the
[VUH-1728 real-service proof](../2026-10-16-companion-fresh-install/README.md)
establishes private handoff/redemption and device reuse. VUH-1833 separately
established first-launch redemption and session restore in an isolated
development-signed app. Neither establishes this outstanding clean-Mac,
signed-distribution, paired-pet criterion.

## Docs verification

The landing site's copy and asset check passed. Chromium checks at 390, 768 and
1440 pixels found the destination, opt-out and current release limit visible
with no horizontal overflow; the 390-pixel capture was visually inspected.
Independent native review checked the claims against installer code and the
retained pairing evidence. Root landing-gate results and uploaded evidence
are attached to VUH-1730.

[Installer results, check logs and review](clankie://evidence/sha256/be25e6c4b326aac5ab54afeaa50d33b6edc1eedf29eaa6634d984a053b1e017a).

![Phone-width install documentation, including the signed-release limit](clankie://evidence/sha256/134c658dff2b245d2a8d88096024f5c729c60eeb1b3b3c187d31ab99b1109859)
