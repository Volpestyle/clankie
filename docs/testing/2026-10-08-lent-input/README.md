# VUH-1840: bounded lent input

The joined host now accepts one authored navigation key, drag or scroll per
fresh capture, through the existing computer API/CLI. Host-local observation
consent and separate input opt-in, live screen policy, exact window, explicit
foreground and changed accessibility effect remain required. Named navigation
keys only; scroll has an image-pixel anchor and 1–10 ticks; drag has eight
bounded motion steps inside the captured window. [ADR 0256](../../adr/0256-lent-input-needs-native-drain-proof.md).

Stop fences queued input, cancels remaining native sequence steps and attempts
cleanup of only its held key/button. Native observers acknowledge exact tagged
events, without absorbing foreign input into a baseline. Both parent and helper
refuse release after any attempted effect, even a claimed clean Stop. **Observer
acknowledgment is not true target-queue drain proof.** James accepted this bounded
landing on 2026-10-08; no app-cooperative drain mechanism is implemented.

## Verification boundary

The [17 focused integration checks and two affected package types](focused-passed.txt)
passed. They use real HTTP, encrypted join envelopes, stores, the production
receiver/parent/body journals, and a clearly synthetic owned subprocess. They
cover bounded raw receipts/no replay, false clean Stop remaining held, foreign
session/lease proofs, pending events, held controls, busy/lost observer refusal,
in-flight synthetic person takeover and supervised parent Stop cancelling motion.
They do not execute native GUI, capture or input. The original [failed focused
run](focused-first.txt) exposed an invalid-session exception; recovery now
refuses malformed helper proof as held.

All builds/checks run through `clankie heavy --`. Native helpers are compiled
only, never loaded/invoked or executed. On Windows only `LentScreen.cs` is copied
to a fresh PC-user `%TEMP%` directory, compiled with `Add-Type -OutputAssembly`,
and deleted; [exact commands](windows-passed-commands.json) and
[output](windows-passed.txt) retain `TYPE_NOT_LOADED=True` and `TEMP_REMOVED=True`.
Passed Windows source SHA-256:
`f2091c3cd65357026656817dc75b8ee986dae4e91c901b73eab5df470a1407c5`. The first [Windows compile](windows-first.txt) refused the
.NET C# compiler's unsupported await in catch; [its transcript](windows-first-commands.json)
retains cleanup. Cleanup was moved after the catch. The first Mac command
[failed to locate swift-format](mac-first.txt); `xcrun` selects Xcode's tools.
Another [Mac compile refused a concurrent source edit](mac-overlap.txt); final
native evidence matches the finished source hashes. The [final Mac command](mac-passed-commands.json)
and [output](mac-passed.txt) passed; its compiled output was never executed.
Passed Mac source SHA-256: `99105c5c73222e32091159ee5d660be07f6bbdde9e187613809082b73244f9a4`. No compiler warnings
are suppressed.

## Why queue drain stays held

[Microsoft's low-level keyboard hook](https://learn.microsoft.com/en-us/windows/win32/winmsg/lowlevelkeyboardproc)
observes an event before posting into a target thread queue and can be silently
removed. [SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)
returns inserted event counts, not application completion. Mac event tap
acknowledgments similarly do not attest to application queue consumption.
Windows additionally monitors [raw device input](https://learn.microsoft.com/en-us/windows/win32/inputdev/about-raw-input)
to fence person takeover. Target-queue drain is never inferred from these
observations, a receipt, a timeout or process exit.

## Open acceptance

- True native queue-drain proof before releasing a post-input lease remains
  explicitly open on [VUH-1840](https://linear.app/vuhlp/issue/VUH-1840).
- Owner-present real Mac and Windows key/drag/scroll effects, visible pet Stop,
  queued/in-flight cancellation, person takeover and permission readiness remain
  live gaps, including [VUH-1803](https://linear.app/vuhlp/issue/VUH-1803).
- App/gateway contracts are unchanged; no app-cooperative drain or hosted deploy.

No real capture, input, GUI, permission change, install, service restart, or
deploy occurred. [The pre-rebase landing gate](landing-before-rebase.txt) passed 30 package types,
19 files and 266 tests with no added exclusions. Final rebased landing evidence
is attached to VUH-1840.
