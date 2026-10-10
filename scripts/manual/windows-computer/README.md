# Windows native fixture check

A manual integration fixture for VUH-1620, not a model comparison or eval.
Nothing in CI, `pnpm check`, builds or releases launches it or runs its grader.
Do not open the fixture or send desktop input until the lead clears a driving
window with James. Only this disposable app is in scope; KH2, Herdr, agents and
James's other apps remain outside the check.

`Fixture.cs` uses real Windows Forms text, focus, button, scroll, drag and secondary
window events. It writes its state to a private directory atomically. It contains
no UI automation or input-injection engine. The existing .NET Framework compiler
builds it without opening a window. The [frozen manifest](manifest.json) declares
eight cases and the refusal boundaries; `check.ts` pins its digest. Changing
fixtures or expected outcomes requires a reviewed fixture revision.

## Prepare without driving

From this checkout:

```sh
pnpm computer:windows:fixture prepare /tmp/windows-native-case
```

Transfer that new private directory to a task-owned Windows location. Compile
through the existing SSH shell (no desktop input):

```powershell
& 'C:\path\to\prepared\build.ps1' -OutputDirectory 'C:\path\to\new-run'
```

The output directory must be new. Retain the emitted executable hash. The script
never installs software, opens a window, changes `desk-agent`, alters app grants
or starts a model. The fixture executable takes the run directory as its only
argument, and refuses a directory with an existing `state.json`. Launching that
executable in the active console is a separate approved step; an SSH session is
not an interactive desktop. Use a native allowed app launch or have James open
it. Do not introduce a `C:\desk` input fallback.

## Receipt strategy to validate in the approved window

First establish native inventory/capture and explicit geometry, then inspect the
actual window/UIA output. An input requires the latest exact-window screenshot,
current lease/authority, owner app grant and explicit foreground permission:
the documented Windows API activates its target automatically. Missing grants
or a forbidden foreground change refuse before dispatch.

Use one primitive per fresh observation. Treat the native call returning as
settlement of that call, never as proof of its effect. Capture the same target
again immediately with screenshot and UIA text, and verify the specific intended
state: target focus for a focus click, literal field value for typing, focus or
selection change for a key, the changed button result, scroll content, or card
order. A changed PNG digest alone, unrelated UI changes, or model assertions
cannot confirm an action. UIA indexes must come from that actual observation;
inspect its real format before mapping any element ID.

Only an observed effect is `confirmed`. Pre-dispatch validation failure is
`failed`; missing, unchanged, ambiguous or interrupted post-observation is
`uncertain`. Stop on uncertainty, never replay with a new request UUID, retain
the lease, and record remaining cases as incomplete. Do not weaken the grader
or assert quiescence from an ended call, a closed listener or a quiet fixture.
The native adapter's missing stop-proof capability remains a gap. Sign-ins,
codes, CAPTCHAs, payments, account changes and destructive operations are outside
this fixture and retain ADR 0127's person-only stops.

The grader independently reads the native app's event state and actual host
receipts. The driver observes the app through the native computer body; it must
not read or write `state.json` to accomplish tasks. Fixture bookkeeping is a
separate verification step, not an automation motor.

## Retain and grade

After each approved case, copy its real `state.json` to the same evidence directory:

```sh
pnpm computer:windows:fixture checkpoint RUN_DIR W2
pnpm computer:windows:fixture receipt RUN_DIR W2 ACTUAL_RECEIPT_JSON
```

For W1 save `W1.inventory.json`, `W1.screenshot.json`, and its actual PNG as
`W1.png`. For W2–W7 save the real computer receipts; retain screenshots/UIA before
and after each primitive alongside them. A multi-action case retains intermediate
receipts separately; its named final receipt is not evidence of the earlier
steps. Case receipts cannot reuse the same request UUID.

W7 additionally keeps the current `W7.inventory.json` and actual stale/cross-window
HTTP result as `W7.refusal.json` (`status`, `body`). W8 retains
`W8.before.state.json`, the host's `W8.revocation.json`, its follow-on
`W8.refusal.json` (`status`, `body`), `W8.status.json` showing recovery required,
and `W8.state.json` after refusal. A refused input must leave the native event
state unchanged. No stop-proof claim or automatic release follows.

```sh
pnpm computer:windows:fixture grade RUN_DIR
```

Missing proof stays unavailable; failed or unavailable cases exit nonzero.
`grade.json` is written once so a rerun cannot overwrite a prior verdict. Inspect
those retained native screenshots/UIA before claiming Windows input works.
These commands invoke no model, computer API or desktop action.
