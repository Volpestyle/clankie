---
name: desktop-control
description: >-
  Use when Clankie needs general native computer use: macOS hands or native Windows
  control through the shared computer body. Screenshots,
  accessibility inspection, clicking, typing, scrolling, dragging, or menus.
  Also covers handing a hard task in the person's own apps or signed-in Chrome
  to a computer-use harness seat (Codex computer use, Claude in Chrome).
  Use browser tools for web pages and purpose-built APIs when they cover the task.
---

# Native computer use

On macOS, use the installed Peekaboo CLI through the existing machine-authorized `bash`
tool. Read its screenshots with the existing image-capable `read` tool. Clankie
chooses each action from the latest observation; call Peekaboo's primitives
directly. `peekaboo agent` and `--analyze` start separate model reasoning and are
unnecessary for this workflow. Operator and authenticated Discord machine grants
own machine access; social rooms do not.

The loop is always: observe, **read the actual image**, decide one action, act,
observe again. A shell response containing a filename does not show the image to
the model, and dispatch alone does not prove the intended result.

When your reach card lists a computer-use harness, a long flow in your
person's apps usually goes better as a hired seat:
[delegating to a computer-use seat](reference/delegation.md) covers choosing the
harness, the brief, human checks and the report. The rest of this skill is for
driving the desktop yourself.

## Stay off the owner's screen

The screen belongs to the person using it, so screen work runs in the
background. Two routes do that on their Mac:

- **Codex computer use**: a Codex seat hired with `mcpServers: ["node_repl"]`
  works in background windows without taking the pointer or keyboard. Use it
  for flows in their apps or their signed-in Chrome, like a web form under
  their account ([delegation](reference/delegation.md)).
- **agent-desktop** (`agent-desktop status`, then `agent-desktop skills get
desktop`): reads an app's accessibility tree and acts on its elements. Use its
  accessibility actions only. `focus`, `focus-window`, `hover` and the mouse
  commands take the screen; when an element can only be reached that way, stop.

Peekaboo input without `--foreground` stays in the background as well. Never
bring an app or window to the front, move the pointer, type into a window they
are using, or open a window over theirs. A Claude in Chrome seat fronts Chrome
windows, so it needs the owner's yes for that task, asked right then. When the
work can only happen in front of them, stop and say so.

The `desktop` tool expresses Clankie's presence (emote, bubble, movement); it
does not drive apps. Peekaboo is his own hands, guided by this session's current
observation. A hired Codex computer-use seat is another visible driver; coordinate
one active driver on the display instead of overlapping it with Peekaboo.

## Discover the target

```sh
command -v peekaboo
peekaboo --version --json
peekaboo permissions status --all-sources --json
peekaboo window list --app "$APP" --json
```

`APP` comes from the task or app inventory. Select the intended current window
from the result and assign its exact ID to `WINDOW_ID`. Titles can change and
an app may have several windows; do not assume a fixed title or first window.
Read the installed command's `--help` before using unfamiliar flags. Installation
and host details live in [desktop control](../../../docs/desktop-control.md).

## Observe, inspect the image, then decide

Assign `IMAGE_PATH` to a caller-owned temporary PNG path, then capture:

```sh
peekaboo see --app "$APP" --window-id "$WINDOW_ID" --path "$IMAGE_PATH" --json
```

Check the receipt and read the image at the returned path with `read`.
Use screenshot evidence when AX omits content; a sparse tree does not establish
that the window is empty. For text-only inspection:

```sh
peekaboo see --app "$APP" --window-id "$WINDOW_ID" --tree --no-screenshot --json
```

For a depth-limit result, use `--depth 48 --max-elements 1600 --max-children 250`.
Depth cannot repair a missing exact-window binding. Check `semantic_scope`,
`snapshot_reusable`, `mutation_targeting_available`, warnings, and the actual
content. `application_partial` and a null snapshot cannot support element actions.
An ID in debug output does not override the receipt's authority fields.

Observation is read-only with respect to focus. Leave `--web-focus` off unless
focus-changing discovery is authorized. Keep private screenshots outside the repo.

## Capture host and the classic engine

Peekaboo 4.3.0 can refuse remote capture with a misleading “predates safe
process-lifetime ScreenCaptureKit ownership” error even when permissions are
granted. Inspect the selected/local permission results and the exact refusal.
Do not kill a host, change permissions/signing, or edit ownership state to clear it.

For authorized **read-only pixels**, the documented caller-local classic path
works independently of ScreenCaptureKit ownership:

```sh
peekaboo see --app "$APP" --window-id "$WINDOW_ID" --no-elements \
  --no-remote --capture-engine classic --path "$IMAGE_PATH" --json
```

This requires permission in the actual calling context; it is not a remedy for
permission or app-access denial. Read the resulting image. Its `snapshot_id`
belongs to that short-lived local process and is not reusable by another CLI
process after exit. Treat it as visual observation, not an action-ready snapshot.

## Act and observe again

For an authorized element click, copy both IDs from a fresh, reusable observation:

```sh
peekaboo click --on "$ELEMENT_ID" --snapshot "$SNAPSHOT_ID" --json
```

Peekaboo also provides `type`, `press`, `scroll`, `drag`, `set-value`, `action`,
and menu commands. Select the primitive that matches the intended effect and
read its help. Use coordinate input only with a fresh screenshot and a valid
live producer receipt; map through `coordinate_context` instead of treating
image pixels as desktop points. OCR text is context, not an actionable AX node.

Normal CLI snapshots belong to an on-demand host and route later calls back to
that producer. If explicitly selecting a `--bridge-socket`, keep that host for
observation and action. Separate `--no-remote` processes do not share snapshots.
Never invent or transplant references, or reuse one after its producer exits.

Respect task restrictions on foreground changes and input. A command requiring
`--foreground` is not a background substitute. Do not add it or use `--web-focus`
to get around a no-focus constraint. Named AX actions must be advertised by the
observed element; do not guess them.

After each action, observe the same target again and inspect the new image/state
before deciding the next action. Inspect indeterminate results before considering
another action; do not blindly replay clicks or keys. Report capture, inspection,
and interaction proof separately. An unavailable action path is a provider
limitation to resolve, not a reason to build an app-specific desktop driver.

## The shared computer body, lent screens and Windows

The shared computer body is available through `clankie computer request JSON`
(`conversationId`, `command`, and `machineId` for an explicitly lent screen).
Acquire its driver lease, inventory PID/window IDs, capture and save its frame
with `--image-path NEW_PNG_PATH`, read that image, then send ordered input
against the fresh screenshot UUID. Reconcile the same request UUID after
transport loss and never replay an uncertain input. Omitting `machineId` uses
the local body; failed selection never picks another screen.

- A **lent screen** at `screen` level only permits asking: its host owner
  confirms observation for one session locally and separately allows input.
  Keep the visible pet and Stop available, and stop on person takeover, access
  reduction or uncertain results.
- On **Windows**, use the native Codex computer-use plugin through the Windows
  computer host, not Peekaboo. Every attachment defaults to read-only; input
  needs an owner's deliberate `allowInput: true` in a clear driving window, and
  is implemented but not yet released for live use. Never overlap the person's
  use or another driver, and keep ADR 0127's sign-ins, codes, CAPTCHAs,
  payments, account changes and destructive steps with the person. Respect the
  installed plugin's app/shortcut denies and never bypass native grants.

Leases, recovery, input bounds and the Windows adapter's rules:
[shared body](reference/shared-body.md).
