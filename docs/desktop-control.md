# Native desktop control

Clankie's native macOS desktop integration uses the
[background AX helper](../apps/desktop-control/README.md) for Spotify native
references and menu operations, plus the standalone
[Peekaboo CLI](https://github.com/openclaw/Peekaboo/releases/tag/v4.3.0) for
general desktop operations. Both run through his existing machine-authorized shell. The
[desktop-control skill](../.agents/skills/desktop-control/SKILL.md) supplies
discovery, exact-target observation, snapshot handling, and verification.
Operator conversations have machine tools. Authenticated Discord machine
grants use the same tools, while social turns remain without a shell; the
[authority plan](../apps/clankie/src/captain/system-authority.ts) owns this
distinction.

## Current readiness

The local CLI is Peekaboo **4.3.0**, source
`44eff916c3330739108cc1d73683338d4250503a`. Version/help and strict signature
and notarization checks pass. The selected snapshot host reports Screen
Recording, Accessibility, and Event Synthesizing granted.

Background Spotify AX reads are **live in the local calling shell**. The native
helper's two bounded reads expose song rows and More options controls while
preserving Ghostty's PID/generation as foreground, with no observed activation
events and stable returned semantics and Play/Pause labels. Its 2000-node cap
marks the result incomplete; it does not claim the whole library was enumerated.
The current Peekaboo exact-window read also succeeds: `--depth 48` reaches song
rows behind Spotify's nested containers, while the default depth 12 does not.
An `application_partial` result remains a distinct exact-window failure; raising
depth is appropriate only when the result actually names a depth limit.

Exposure is state-dependent: a current background window can return only
16–17 native frame/group nodes and no song controls even at depth 48. The read
proof reports failure for that state. `incomplete: false` means the returned AX
graph was traversed within its bounds, not that Spotify exposed its content.

Background menu open/dismiss and the new helper's execution through Clankie's
service require independent proof. Full native desktop parity remains unproven.
The helper's action dispatch receipt reports an unverified effect, never menu
success. Read proof performs no focus setter, exposure setter, playback command,
library write, or menu action. In a `loginwindow` foreground state, Spotify can
return an `AXApplication` in `AXWindows`; the helper refuses that result with
`invalid_root`. A successful interactive-desktop receipt does not prove access
in a different desktop session.

Peekaboo pixel capture remains refused by its ScreenCaptureKit coordination
guard. Its 4.3.0 startup scan identifies Claude Desktop as an uncoordinated
potential host, removes the selected daemon's ownership capability, and emits
a misleading old-host refusal. [Upstream #684](https://github.com/openclaw/Peekaboo/pull/684)
separates readiness from implementation support. This capture issue is not a
permission deficit or a prerequisite for native AX observation.

## Background AX helper

```sh
python3 apps/desktop-control/install.py
~/.local/bin/clankie-desktop diagnose
python3 apps/desktop-control/client.py ~/.local/bin/clankie-desktop
```

The source, decision, stdio protocol, limits, and inert tests live in
[apps/desktop-control](../apps/desktop-control/README.md). The separately installed
local build occupies a binary-hash directory under
`~/.local/share/clankie/desktop/`, with source hashes and signature evidence in
`manifest.json`. It preserves the existing Peekaboo installation. The helper
has no listener, autostart, synthetic input, capture, or model dependency.

One stdio session holds native AX root/element references. Before a menu action
it revalidates process generation, native ancestry and identity, current action
support, and the session's foreground state/history. Action admission requires
the explicit `--allow-menu-actions` startup flag. Only advertised popup/row
menu operations and menu cancellation are supported. Before opening, require
established cancellation/discoverability for the matching menu and context, or
explicitly authorize a controlled experiment with a separate recovery plan. The
first opening cannot be called assuredly reversible when cancellation cannot be
preflighted. Focus failure also refuses observation and cancellation; closing
the helper does not dismiss the menu. Record a stranded/indeterminate result
under the recovery plan, with no automatic focus, Escape, or popup-toggle fallback.

Root discovery combines `AXWindows`, `AXMainWindow`, `AXFocusedWindow`, and
direct application-child windows/menus by native identity. A background Spotify
window can remain accessible through its main/focused reference when `AXWindows`
is empty. `diagnose` reports the raw window count and combined `discoveredRoots`
separately. Selection uses one current native window, not a fixed title such as
`Spotify Premium`; titles can name the current song. All sources share the same
bounds and live revalidation. Their union does not certify that every off-screen
menu is exposed, so inventory alone cannot establish menu dismissal.

One deadline includes root discovery and final dispatch checks. Truncated root
inventory refuses; it cannot prove dismissal. A pipe timeout, framing/shape, EOF,
or output failure permanently closes the client and retains possible action
dispatch. Subsequent writes refuse; a new session never implies action replay. Native handles and Peekaboo snapshots belong to
different providers and are never interchangeable.

## Installation and permissions

The official universal release archive is installed intact, including its
Swift compatibility library and MIT license:

| Item                   | Location or identity                                               |
| ---------------------- | ------------------------------------------------------------------ |
| Executable on PATH     | `~/.local/bin/peekaboo`                                            |
| Versioned distribution | `~/.local/share/peekaboo/cli/4.3.0/`                               |
| Executable link target | `../share/peekaboo/cli/4.3.0/peekaboo`                             |
| Archive SHA-256        | `fec965e4bd6371b8fb017fb582e8d31c6a59628f77e266878f45cf1d4844836f` |
| Signing identity       | `Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)`       |

The distribution's README documents putting the CLI on PATH. This user-owned
installation needs no `sudo` or shell configuration change. The
[official installation guide](https://github.com/openclaw/Peekaboo/blob/v4.3.0/docs/install.md)
also provides Homebrew and npm distributions. Verify a release's archive
against its published checksum and preserve its signed executable and adjacent
libraries. Avoid an unpinned download during a captain turn.

For this non-app executable, the relevant notarization check is:

```sh
codesign --verify --strict --verbose=4 -R='notarized' --check-notarization \
  ~/.local/share/peekaboo/cli/4.3.0/peekaboo
```

`spctl --type execute` reports that this raw binary is valid but is not an
app; that result is not a passed app assessment. Signature and explicit
notarization verification cover both the CLI and its adjacent
`libswiftCompatibilitySpan.dylib`.

Check the executable and permissions from the actual execution context:

```sh
command -v peekaboo
peekaboo --version --json
peekaboo permissions status --all-sources --json
```

The [permission guide](https://github.com/openclaw/Peekaboo/blob/v4.3.0/docs/permissions.md)
requires macOS 15 or later, Accessibility for native UI automation, and Screen
Recording for capture. Relevant keyboard/synthetic-input paths also need
Event Synthesizing. The selected source and runtime socket identify the host
whose permissions matter. Pin that socket with `--bridge-socket` when comparing
permission and observation results; an initial default host and the
build-scoped snapshot host can differ.

If a permission is denied, report that host and the missing permission. The
human enables the identified host in System Settings → Privacy & Security →
Accessibility or Screen & System Audio Recording, then repeats the check.
Do not change TCC, remove quarantine, replace signatures, or route through
Codex's permissions. Runtime compatibility refusals are distinct from missing
permissions; permission changes are not a demonstrated fix for the current
Spotify result.

## Observe through the existing tools

```mermaid
flowchart TD
  O[Operator conversation] --> A[Existing machine authority]
  D[Authenticated trusted Discord turn] --> A
  S[Social Discord turn] --> N[No machine shell]
  A --> B[Clankie bash tool]
  B --> C[Peekaboo CLI]
  B --> L[Caller-owned background AX stdio helper]
  L --> P
  C --> H[On-demand snapshot daemon or selected Bridge]
  H --> P[macOS permissions and target validation]
  P --> X[Native app accessibility or pixels]
  X --> R[Observation or precise refusal]
  R --> B
```

Inventory the app, then select the observed exact window. `WINDOW_ID` below
is assigned from the returned inventory, never copied from an old receipt:

```sh
peekaboo window list --app Spotify --json
peekaboo see --app Spotify --window-id "$WINDOW_ID" --tree --no-screenshot --depth 48 --max-elements 1600 --max-children 250 --json
```

[Tree-only observation](https://github.com/openclaw/Peekaboo/blob/v4.3.0/docs/commands/see.md)
does not focus the target or save screenshots. `--web-focus` is a separate
focus-changing operation and is inappropriate for read-only proof. Check
partial-read warnings and snapshot eligibility before using element IDs.
Successful CLI exit alone is insufficient. A snapshot-like string in a debug
log does not supersede `snapshot_id: null` in the result.

The supported on-demand daemon holds snapshots in memory and exits after its
idle timeout. It uses local Unix sockets, not an added HTTP/TCP service or a
login item. Default permission inspection can select `daemon.sock`; `see`
can select a build-scoped `daemon-<build-id>.sock`. Explicit socket selection
keeps a sequence on one host. A concrete snapshot reference belongs to its
live producer; process exit invalidates that continuity. Do not assume two
`--no-remote` CLI invocations share snapshots.

For authorized visual observation, pass a private temporary screenshot path
and use Clankie's existing image-capable `read` tool. Pixel evidence does not
establish accessible rows. Keep only the receipt needed for the task; library
dumps and screenshots do not belong in this repository.

## Interaction and verification boundary

An authorized interaction uses an element and reusable snapshot from fresh
observation. [Click](https://github.com/openclaw/Peekaboo/blob/v4.3.0/docs/commands/click.md)
and [named AX actions](https://github.com/openclaw/Peekaboo/blob/v4.3.0/docs/commands/action.md)
have different foreground rules. In particular, `action AXPress`,
`action AXShowMenu`, and `action AXCancel` require explicit foreground mode.
The dedicated AX helper expresses the measured background contract without
changing Peekaboo's policy. Inspect the installed
help and the task's authorization before choosing a route. Observe again
after every action; a dispatched event does not prove a visible effect.

The independent proof follows the actual Clankie operator conversation →
shell tool → installed CLI → real host → Spotify path. Record version,
execution host, permissions, exact target, semantic completeness, snapshot
eligibility, and outcome. Report observation and interaction separately.
Read-only proof excludes focus changes, clicks, menu opening, playback, and
library edits. A later authorized interaction proof can open and dismiss a
specific More options menu without choosing an entry, then confirm the prior
state; it remains a separate unit.

## Interface choice

Peekaboo's [MIT license](https://github.com/openclaw/Peekaboo/blob/v4.3.0/LICENSE)
and public CLI support reuse without copying Codex's proprietary desktop
plugin or helper. Pi's existing shell and skill mechanism supplies the
integration; no extra model runtime is needed. The bounded native helper owns
only the retained-reference and background menu contract described above.
Use purpose-built interfaces for basic playback and browser tools for page
content.

Peekaboo also provides a supported
[stdio MCP server](https://github.com/openclaw/Peekaboo/blob/v4.3.0/docs/MCP.md).
Clankie's [MCP host](../apps/clankie/src/mcp-host.ts) currently projects only
text results and distinguishes operator-only servers from servers available
everywhere. Direct desktop MCP exposure needs image/metadata fidelity and
authenticated machine-turn authority at that boundary. Enabling an
`everywhere` desktop server would give social rooms machine access; it is not
the CLI integration. [ADR 0109](adr/0109-mcp-is-how-he-reaches-a-service.md)
remains the ownership model for any future MCP connection.
