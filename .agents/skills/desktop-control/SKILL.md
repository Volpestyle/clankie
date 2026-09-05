---
name: desktop-control
description: >-
  Use when Clankie needs to observe or interact with native macOS apps through
  accessibility trees, element IDs, menus, or screenshots. Not for browser page
  automation or Spotify's basic AppleScript playback controls.
---

# Native desktop control

Use the background AX helper for Spotify, or the supported Peekaboo CLI for
general native desktop work, through Clankie's existing machine-authorized
`bash` tool. The operator and authenticated Discord machine grants own that
access; social rooms do not. Clankie supplies the reasoning, so call the native
primitives directly rather than starting `peekaboo agent`.

Use the browser tools for web pages and a purpose-built API or CLI when it
already covers the task. Spotify's AppleScript playback dictionary does not
provide song-row or menu accessibility control.

## Background Spotify AX

```sh
command -v clankie-desktop
clankie-desktop diagnose
```

The [helper protocol and client](../../../apps/desktop-control/README.md) use
one caller-owned stdio process. A Python script can hold `Desktop(binary)`
while it requests `windows`, then `observe` on one returned native root handle.
Use depth 48 and an explicit node budget; a `roles` filter limits presentation,
not traversal. `diagnose` retains AXWindows errors, candidate count, optional
window-number results, app exposure, and foreground identities. It does not
enable accessibility, focus the app, or prompt for permissions.

Before opening, establish that a matching menu has a discoverable, working
`AXCancel` path in the relevant background context. If that cannot be
preflighted, opening is a controlled experiment requiring explicit authorization
and a separately authorized recovery plan; it is not assured reversible proof.
A focus violation, transport failure, or incomplete discovery can strand even
a cancel-capable menu. Closing the helper does not dismiss it. Do not invent
Escape, a popup toggle, focus restoration, or a latch bypass as recovery.

Within that authorization, start the session with `--allow-menu-actions`
(`Desktop(binary, allow_menu_actions=True)`). Select exactly one fresh row or
More options popup by its observed semantics, then send `menu` with the current
snapshot, element ID, and an advertised action. Supported pairs are
`AXShowMenu` on a row/popup, `AXPress` on a popup, and `AXCancel` on a menu.
Never press a song's Play button or choose a menu entry for an open/dismiss proof.

Keep the process alive: snapshots and element IDs expire on process exit,
after 30 seconds, or after another observation/inventory or a dispatch attempt.
Window handles last until a new inventory or process exit, subject to live
membership validation. Observe again after each action. The helper validates retained ancestry and process
generation; an old label/ID is never a fallback. Bounded partial coverage does
not prove a menu is absent. `incomplete_inventory` refuses truncated root
discovery; `operation_timeout` invalidates the snapshot. If cancellation is
unadvertised, report the stranded/indeterminate result under the recovery plan.

The session pins a distinct foreground process and monitors activation events.
It never requests focus. `focus_changed` means background proof failed, even
if the app caused it internally; stop. The latched session refuses reads and
cancellation too. Do not restore focus, send
Escape, or replay an indeterminate action automatically. Successful dispatch
is still `effect: unverified`. Current local evidence proves background reads;
service execution and real menu open/dismiss require their own receipts.

A client timeout, EOF, framing/shape, or output failure permanently closes the
pipe. `TransportError.action_may_have_dispatched` preserves uncertainty; never
reuse that instance or replay an action. A fresh session is only for deliberately
chosen inspection. A well-framed native refusal can leave the existing transport
usable for inspection if its focus contract still holds; check `success`,
`actionDispatched`, `retrySafe`, and the requested result fields. Check stability
flags and actual Play/Pause label coverage separately from read-proof `success`.

These native handles are separate from Peekaboo snapshot/element IDs. Never
pass one provider's IDs to the other.

## Discover and observe

```sh
command -v peekaboo
peekaboo --version --json
peekaboo permissions status --all-sources --json
peekaboo window list --app Spotify --json
```

Read the installed command's `--help` before using unfamiliar flags. The current
installation is documented in [desktop control](../../../docs/desktop-control.md).
If the service cannot find the executable, use the verified absolute path from
that installation. Do not install a replacement or change config to hide a
missing command.

Take the exact application and window ID from inventory. For example, with
`APP` and `WINDOW_ID` assigned to those observed values:

```sh
peekaboo see --app "$APP" --window-id "$WINDOW_ID" --tree --no-screenshot --json
```

This observation does not focus the target. Leave `--web-focus` off unless
focus-changing discovery is explicitly authorized. Check warnings and semantic
scope, not just `success` or exit code: `application_partial`, a null
`snapshot_id`, `snapshot_reusable: false`, or
`mutation_targeting_available: false` cannot support element actions. An ID in
debug logs does not override those result fields. Report incomplete AX reads;
do not repeat an app-tree fallback the result says it already performed.

For a proven depth-limit result on Spotify, use `--depth 48 --max-elements 1600`
with `--max-children 250`. The ordinary depth 12 can stop before nested song
rows. Raising depth does not repair `application_partial` window binding.

For an authorized screenshot, pass an explicit temporary `--path` and read that
image with the existing `read` tool. `--no-elements` produces pixel evidence,
not an AX element map. Keep only the minimal requested receipt; do not archive
library contents or screenshots in the repository.

## Target continuity and actions

Copy opaque element IDs and the reusable snapshot ID exactly from a fresh
successful observation. Never guess IDs, infer a role from their spelling, or
use OCR text as an accessibility action target. For an authorized click:

```sh
peekaboo click --on "$ELEMENT_ID" --snapshot "$SNAPSHOT_ID" --json
```

Normal CLI discovery uses an on-demand snapshot daemon. Snapshot references
belong to their live producer and route later calls back to it. If using an
explicit `--bridge-socket`, keep the same socket for permission checks,
observations, and actions. Separate `--no-remote` processes do not share
in-memory snapshots. If the owner expires or the target changes, observe again;
do not recreate an old reference or replay an uncertain action.

`action` invokes a named AX action; `set-value` writes a settable control.
`action AXPress`, `action AXShowMenu`, and `action AXCancel` require `--foreground`. Treat that as
a visible interaction and obtain the appropriate task authorization, never as
a retry flag for a refused read. Do not grant macOS permissions, manipulate
TCC, remove quarantine, or change signing to make a command work. Report the
selected host and its exact missing permission or runtime refusal.

After each action, run `see` again against the same target and derive fresh
IDs. A dispatch receipt is not proof of the intended effect. Use `verify` for
bounded state polling when appropriate; `unknown` is not success. On an
indeterminate result, inspect before deciding whether another action is safe.

For Spotify, distinguish the song row, its Play button, and its More options
control. Do not press Return with uncertain focus: it can affect playback.
Read-only proof excludes clicks, focus changes, playback, and library edits.
