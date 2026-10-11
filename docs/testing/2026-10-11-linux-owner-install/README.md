# Linux owner install: VUH-1823

Tracks: [VUH-1823](https://linear.app/vuhlp/issue/VUH-1823/linux-install-and-run-clankie-with-one-command).

The installer now selects Linux arm64/x64 archives, verifies SHA-256, installs immutable versions, and starts the existing detached launcher service before refreshing harness integrations. That ordering fixes a real fresh-install failure: harness refresh previously required an operator credential before first service startup could create it. Linux bash PATH setup uses `.profile`. Docs describe Ubuntu 24.04 LTS+, prerequisites and the portable launcher lifecycle.

## Observed passing proof

Fresh non-root Ubuntu 24.04 Docker containers ran the exact `curl -fsSL https://clankie.bot/install | sh` command for arm64 and x64. x64 ran through Docker emulation on this arm64 Mac, not physical x64 hardware. Every container/build/test command ran through `clankie heavy`; runtime containers used Docker init, 4 CPUs and 8 GiB memory.

The isolated HTTPS fixture served locally built release archives at the official URL shapes. Curl and bundled Node verified its test CA. No published site, owner account, PC or WSL was changed. Both final `proof-*-complete.log` runs exited 0 and proved matching archive selection/checksum, immutable installation, live service and Herdr health, actual console `/setup` model chooser, corrupt-checksum refusal preserving the current install, and `clankie update --ref v0.4.4` reaching durable `healthy` with actual compiled CLI version 0.4.4. Cleanup used the launcher's own `down` command.

Current v0.4.3 bundles were built with the canonical Linux release Dockerfile from base `f58f5dd0c20b88174eab5d1507ac5a838bc17a48` plus the launcher wording change. The final installer was mounted independently. Next v0.4.4 bundles were separately compiled using the same Dockerfile with a container-only package version change and explicit fixture revision `1111111111111111111111111111111111111111`; this is not a published release or a real Git commit. Archive checksum files, final script/source hashes, driver and source diff are retained in the archive.

Focused installer/services/release-update/setup-flow checks passed **105/105**; TUI typecheck passed; real Linux installer regression passed **1/1 on each architecture**. Formatter ran directly as instructed. Integration's exact-tree landing gate remains authoritative and its request/result is recorded on the issue.

## Retained failures and limits

The archive retains the original real credential-order failure and intermediate fixture failures. A Python PID 1 fixture did not reap exited service zombies, so update correctly refused `stop-unconfirmed`; adding Docker init fixed the fixture without weakening process proof. Earlier metadata-only next-version candidates were partial evidence and were replaced by separately compiled next bundles plus durable healthy/version assertions. Only the final complete logs establish full cutover success.

[VUH-2118](https://linear.app/vuhlp/issue/VUH-2118/linux-native-workers-need-kernel-backed-fleet-admission) tracks the separate Linux native-worker proof backend: local fleet admission/project proof refuses non-Darwin with `unsupported_platform`. The public runtime constructs this proof for hosted bodies too. Hosted pi model access exists, but no separate native bridge proof bypass was found; private deployment behavior is unverified.

VUH-1823 stays open by lead instruction. Authenticated owner model-account setup, physical phone pairing and first native worker acceptance remain unproven. The latest published release checked was v0.3.3 without Linux archives, so official release availability remains a gap. No release/site deployment was performed. The five-minute post-update canary remained pending at capture; no canary pass is claimed. The portable launcher does not configure logout/reboot autostart.
