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

When your reach card lists a computer-use harness, a long flow in your
person's apps usually goes better as a hired seat:
[delegating to a computer-use seat](reference/delegation.md) covers choosing the
harness, the brief, human checks and the report. The rest of this skill is for
driving the desktop yourself.

The `desktop` tool expresses Clankie's presence (emote, bubble, movement); it
does not drive apps. Peekaboo is his own hands, guided by this session's current
observation. A hired Codex computer-use seat is another visible driver; coordinate
one active driver on the display instead of overlapping it with Peekaboo.

The shared computer body is available through `clankie computer request JSON`
(`conversationId`, `command`). Acquire its driver lease, inventory PID/window
IDs, capture and save its frame with `--image-path NEW_PNG_PATH`. Read that image,
then send ordered input against the
fresh screenshot UUID. Coordinates are image pixels; foreground input is an
explicit choice. Reconcile the same request UUID after transport loss and never
replay an uncertain input. Its macOS adapter preserves Peekaboo's limitations;
recovery needs host stop proof. Contract and examples:
[desktop control](../../../docs/desktop-control.md#shared-computer-body).

## Lend a joined screen

For an explicitly lent computer, pass its registered `machineId: "join-UUID"`
through `clankie computer request` alongside `conversationId` and `command`.
Omitting machineId uses the local body; failed selection never picks another
screen. A hosted Clankie can use this body without a local owner desktop.

`screen` level only permits asking. The host owner confirms observation for
one session locally and separately allows input. Keep the visible pet and Stop
available. Capture, save and read the actual image before choosing one native
accessibility press or literal text append. Use explicit `foreground: true`
and an exact changed `expect` field. Raw key, drag and scroll refuse in this
landing (VUH-1840). Stop on person takeover, access reduction or uncertain
results. Preserve the original request UUID; never replay unknown input.
Recovery remains usable after reduction, but unknown native quiescence holds
the lease. Real Mac/PC driving proof is open; do not infer it from an HTTP
fixture or compile. Setup: [lent screens](../../../docs/desktop-control.md#lend-a-joined-screen).

## Windows native control

On a Windows machine, use the native Codex computer-use plugin's trusted
`node_repl` and `@oai/sky` through the Windows computer host, not Peekaboo.
The host exposes the same computer contract, bound to the owning conversation
and the machine (`windows:studio:console`, for example). Use an SSH loopback forward
when leading from another machine. Setup and limits:
[Windows observation host](../../../docs/desktop-control.md#windows-observation-host).

Every attachment defaults to read-only, even with the full `sky` client. An owner
must deliberately pass `allowInput: true` in a clear driving window before
acquiring a new input lease; lease and status record this choice. An explicitly
enabled full client supports click, literal type, key, scroll and drag. Inspect the exact-window PNG and raw
`accessibility` fields before choosing one primitive. Every Windows input
requires explicit `foreground: true` and `expect: {field, equals}` for an intended
changed native UIA field (`tree`, `focused_element`, `document_text` or
`selected_text`). Only an exact changed value in a fresh same-window observation
confirms the action. A returned call or repaint alone cannot. Re-capture after
each primitive; clear-and-type, control characters and guessed element IDs
refuse. Scroll requires an explicit image-pixel `at` point.

A configured harness in `browser harnesses` does not prove app grants, a free
driving window, or live input readiness. Arrange the driving window with the
person; never overlap their use or another driver. Host Win32 person-activity
checks run before each dispatch; wait two seconds between primitives. A new
input stamp, failed query or session mismatch fences the attachment. Every
native error, revocation and uncertain receipt stops continuation; recovery requires
independent native stop proof. Keep ADR 0127's sign-ins, codes, CAPTCHAs, payments,
account changes and destructive steps with the person. Respect the installed
Windows plugin's app/shortcut denies. Do not bypass native grants or fall back
to `C:\desk`. The adapter denies shell/system apps, Explorer Run, Windows-key
aliases, Ctrl+Escape, Ctrl+Shift+Escape, Alt+F4 and Alt+Tab. Treat Windows input
as unreleased until owner-run live stop evidence passes the manual release fixture.

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
