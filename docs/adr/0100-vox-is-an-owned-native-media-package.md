# ADR 0100: Vox is an owned native media package

Status: accepted (2026-08-15).

## Context

The user-session Discord body depends on ClankVox for screen-share receive and
Go Live publish, but the source lived in the previous Clankie monorepo while
this repository resolved an unmanaged binary from `CLANKVOX_BIN` or the
operator's home directory. The TypeScript IPC client also lived inside
`apps/discord-user-session`, even though the Rust process implements a broader
media plane: Discord voice, DAVE, speaker capture, TTS and music pacing,
screen-watch, Go Live publishing, and transport telemetry.

The previous source is `AGPL-3.0-or-later`. The rest of this repository is
Apache-2.0. [ADR 0025](0025-clankvox-placement-and-ipc.md) therefore prohibited
an unrecorded import, while
[ADR 0098 (user-session shares)](0098-user-session-watches-discord-shares.md)
allowed the compiled process only as an external sidecar. That arrangement
kept the licenses separate but made the binary's source, build, protocol, and
runtime drift independently.

## Decision

The native media source lives at `apps/vox` as the private pnpm workspace
package `@clankie/vox` and Rust binary `clankvox`. Its package-level LICENSE is
AGPL-3.0-or-later and its exact source commit and tree are recorded in
`apps/vox/PROVENANCE.md`, including the digest of the recovered Go Live DAVE
patch that was newer than the base commit. The repository root remains
Apache-2.0; the package license is an explicit mixed-license boundary and no
source is relicensed.

The separate Apache-2.0 package `@clankie/vox-client` owns process discovery,
child lifecycle, framed IPC, typed commands, decoded video, binary speaker
audio, and generic transport events. Discord bodies consume that package
instead of importing code from the AGPL package or carrying private copies of
the protocol. A normal run resolves the workspace release or debug binary;
`~/.clankie/bin/clankvox` remains a compatibility fallback and
`CLANKIE_VOX_BIN` is the explicit override.

The first rollout keeps the existing proven ownership split:

- Vox owns user-session screen-watch and Go Live media.
- `@discordjs/voice` owns ordinary bot and user-session voice.
- The complete Vox voice/audio contract is exposed by the shared client so the
  user-session body can migrate to one media owner separately.
- Official-bot voice moves only after live DAVE, capture, latency, and recovery
  evidence shows that replacing the maintained Discord library is better.

The active user-session body owns the Vox child process in the current rollout.
Vox is a workspace package, not an independently supervised daemon: media
credentials and process lifetime remain scoped to the body that opened the
Discord user gateway.

![Vox native media architecture](../diagrams/vox-architecture.jpg)

[Editable Turbopuffer tldraw source](../diagrams/vox-architecture.tldraw)

## Options weighed

- **Continue resolving an external binary.** Rejected because source, build,
  IPC, and runtime could drift while CI verified only the TypeScript half.
- **Replace all Discord voice immediately.** Rejected because official-bot
  voice already has a maintained, live-proven media owner and a big-bang swap
  would combine source recovery with a production transport migration.
- **Run Vox as a top-level daemon.** Rejected because it would outlive the
  credential-holding body and complicate the one-active-mouth invariant.
- **Relicense the imported source as Apache-2.0.** Rejected without a complete
  contributor-rights disposition. The existing AGPL license is preserved.

## Consequences

- `pnpm typecheck`, `pnpm test`, `pnpm lint`, and `pnpm fmt:check` cover the
  native package through its workspace scripts.
- Building Clankie compiles a release Vox binary in `apps/vox/target/release`.
- Distributions that include `apps/vox` must preserve its AGPL license and
  corresponding-source obligations.
- Discord's normal-user automation risk remains unchanged and stays behind the
  existing personal-lab opt-in and active-body controls.
- [ADR 0025](0025-clankvox-placement-and-ipc.md)'s placement prohibition and
  [ADR 0098 (user-session shares)](0098-user-session-watches-discord-shares.md)'s
  external-binary placement are superseded by this decision; their protocol and
  product boundaries remain.
