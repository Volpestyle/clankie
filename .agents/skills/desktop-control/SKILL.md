---
name: desktop-control
description: >-
  Use when Clankie needs general native macOS computer use: screenshots,
  accessibility inspection, clicking, typing, scrolling, dragging, or menus.
  Use browser tools for web pages and purpose-built APIs when they cover the task.
---

# Native computer use

Use the installed Peekaboo CLI through the existing machine-authorized `bash`
tool. Read its screenshots with the existing image-capable `read` tool. Clankie
chooses each action from the latest observation; call Peekaboo's primitives
directly. `peekaboo agent` and `--analyze` start separate model reasoning and are
unnecessary for this workflow. Operator and authenticated Discord machine grants
own machine access; social rooms do not.

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

Check the receipt and **read the actual image at the returned path** with `read`.
A shell response containing a filename does not show the image to the model.
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
before deciding the next action. Dispatch alone does not prove the intended
result. Inspect indeterminate results before considering another action; do not
blindly replay clicks or keys. Report capture, inspection, and interaction proof
separately. An unavailable action path is a provider limitation to resolve,
not a reason to build an app-specific desktop driver.
