---
name: desktop-control
description: >-
  Use when Clankie needs to observe or interact with native macOS apps through
  accessibility trees, element IDs, menus, or screenshots. Not for browser page
  automation or Spotify's basic AppleScript playback controls.
---

# Native desktop control

Use the supported Peekaboo CLI through Clankie's existing machine-authorized
`bash` tool. The operator and authenticated Discord machine grants own that
access; social rooms do not. Clankie supplies the reasoning, so call the native
primitives directly rather than starting `peekaboo agent`.

Use the browser tools for web pages and a purpose-built API or CLI when it
already covers the task. Spotify's AppleScript playback dictionary does not
provide song-row or menu accessibility control.

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
`action AXPress` and `action AXShowMenu` require `--foreground`. Treat that as
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
