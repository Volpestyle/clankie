# The shared computer body

Contract details behind [the skill's](../SKILL.md) summary. Full contract and
setup: [desktop control](../../../../docs/desktop-control.md#shared-computer-body).

## Leases and recovery

`clankie computer request JSON` takes `conversationId` and `command`. Acquire the
driver lease, inventory PID/window IDs, capture and save the frame with
`--image-path NEW_PNG_PATH`, read that image, then send ordered input against
the fresh screenshot UUID. Coordinates are image pixels; foreground input is an
explicit choice. Reconcile the same request UUID after transport loss and never
replay an uncertain input. The macOS adapter preserves Peekaboo's limitations;
ordinary recovery needs host stop proof.

For an expired local macOS lease only, the owner may explicitly accept unknown
native drain with `recover.ownerRecovery`: record a reason and copy
`expectedHolder` and `expectedExpiresAt` from fresh status. Confirm the old
native driver has stopped first. Fresh operator authority, no service-tracked
holder work and no computer operation are required; the host durably records
this decision before release. This exception cannot recover Windows or lent
screens, and never authorizes replaying uncertain input.

## Lend a joined screen

For an explicitly lent computer, pass its registered `machineId: "join-UUID"`
through `clankie computer request` alongside `conversationId` and `command`.
Omitting `machineId` uses the local body; failed selection never picks another
screen. A body without a local owner desktop can use this one.

`screen` level only permits asking. The host owner confirms observation for one
session locally and separately allows input. Keep the visible pet and Stop
available. Capture, save and read the actual image before choosing one native
accessibility press/text append or bounded navigation key/drag/scroll. Use
explicit `foreground: true` and an exact changed `expect` field. Keys are named
navigation keys only; no chords or Return. Scroll requires an `at` image-pixel
anchor and 1–10 ticks; drag remains in the captured window. Native
acknowledgments never release a post-input lease: true queue drain stays
unknown and the lease held. Stop on person takeover, access reduction or
uncertain results. Preserve the original request UUID; never replay unknown
input. Recovery remains usable after reduction, but unknown native quiescence
holds the lease. Real Mac/PC driving proof is still open; do not infer it from an
HTTP fixture or compile. Setup:
[lent screens](../../../../docs/desktop-control.md#lend-a-joined-screen).

## Windows native control

On a Windows machine, use the native Codex computer-use plugin's trusted
`node_repl` and `@oai/sky` through the Windows computer host, not Peekaboo. The
host exposes the same computer contract, bound to the owning conversation and
the machine (`windows:NAME:console`). Use an SSH loopback forward when leading
from another machine. Setup and limits:
[Windows observation host](../../../../docs/desktop-control.md#windows-observation-host).

Every attachment defaults to read-only, even with the full `sky` client. An owner
must deliberately pass `allowInput: true` in a clear driving window before
acquiring a new input lease; lease and status record this choice. An explicitly
enabled full client supports click, literal type, key, scroll and drag. Inspect
the exact-window PNG and raw `accessibility` fields before choosing one
primitive. Every Windows input requires explicit `foreground: true` and
`expect: {field, equals}` for an intended changed native UIA field (`tree`,
`focused_element`, `document_text` or `selected_text`). Only an exact changed
value in a fresh same-window observation confirms the action; a returned call or
repaint alone cannot. Re-capture after each primitive; clear-and-type, control
characters and guessed element IDs refuse. Scroll requires an explicit
image-pixel `at` point.

A configured harness in `browser harnesses` does not prove app grants, a free
driving window, or live input readiness. Arrange the driving window with the
person; never overlap their use or another driver. Host Win32 person-activity
checks run before each dispatch; wait two seconds between primitives. A new
input stamp, failed query or session mismatch fences the attachment. Every
native error, revocation and uncertain receipt stops continuation; recovery
requires independent native stop proof. Keep ADR 0127's sign-ins, codes,
CAPTCHAs, payments, account changes and destructive steps with the person.
Respect the installed Windows plugin's app/shortcut denies. Do not bypass native
grants or fall back to another desktop agent. The adapter denies shell/system
apps, Explorer Run, Windows-key aliases, Ctrl+Escape, Ctrl+Shift+Escape, Alt+F4
and Alt+Tab. Treat Windows input as unreleased until owner-run live stop evidence
passes the manual release fixture.
