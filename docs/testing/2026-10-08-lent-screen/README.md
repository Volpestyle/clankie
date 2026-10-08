# VUH-1803: bounded lent screen

This landing supplies explicit joined-machine selection through the existing
computer API/CLI, authenticated chunked frames, native host consent and a visible
Stop. Observation is the local default. Session input opt-in permits one
accessibility press or literal text append with an exact changed receipt.
Raw key, drag and scroll refuse; their extension and independent native
quiescence proof are [VUH-1840](https://linear.app/vuhlp/issue/VUH-1840).
Decision: [ADR 0255](../../adr/0255-a-lent-screen-keeps-consent-and-stops-on-its-host.md).

## Evidence boundary

The integration tests run real HTTP, encrypted join envelopes, settings and
credential stores, the production service/receiver/computer journal, and an
owned subprocess. That subprocess supplies synthetic PNG/accessibility data
and records synthetic input; it does not capture or drive a desktop. The tests
prove authority, transport and journal boundaries. They do not prove native
permission readiness, UI appearance, person takeover or real OS input.

The native helpers are authored here and compiled only. They do not borrow or
redistribute a harness computer implementation. No real screen was captured,
input sent, permission requested, app installed, service deployed or restarted.
No real credentials, approval codes or mail contents appear in this evidence.

## Checks

The focused suite covers explicit selection/authentication, local consent and
its denial/delay, read-only default, bounded chunk reassembly/digest, live level
reduction, queued-input fencing, unsupported primitives, exact one-shot input
receipts, unknown Stop held, and refusal to clear an older held lease using a
fresh native process. The JSON-parent checks cover local status/Stop,
registration/removal, invalid input-enable controls and stdin loss.

All compilers and checks run through `clankie heavy --`. The [focused suite](focused-tests.txt)
passed 13 tests in two files, including the real computer CLI round trip and refusal of a malformed claimed
effect receipt without replaying the host input;
[four affected package typechecks](focused-types.txt) passed. [Formatting](format-native.txt)
and [the Mac helper compile](mac-compile.txt) passed. The Mac output was never
executed. The required landing gate is run after rebasing onto current main.

### Windows compile only

Owner authorization permitted copying only `LentScreen.cs` to a fresh directory
under the PC user's `%TEMP%`, compiling with `Add-Type`, and deleting that
directory. The helper assembly was written to disk without being loaded or
invoked. The passed source SHA-256 is
`85ecbe2d206d3fa2045b3145c4c903c658e871e9626d96cc5d79c3e4da3a92ec`.

[Exact commands and stdout](windows-passed-commands.json) record (as a JSON transcript preserving stdout padding) the fresh
directory, single-file copy, compiler references, `TYPE_NOT_LOADED=True`, and
`TEMP_REMOVED=True`. [Wrapper output](windows-passed.txt) retains the fleet wait
and PowerShell module preparation output. Earlier compile attempts refused
unresolved framework references and a method hiding a base member; every
temporary directory was removed. The first wrapper filtered its compiler
diagnostic; the later direct commands retain complete output. The final source fixes those errors without
suppressing compiler warnings.

Failed-attempt commands and output are retained as well: [first commands](windows-commands.txt)
and [output](windows.txt), [framework-reference commands](windows-final-commands.txt)
and [output](windows-final.txt), [method-warning commands](windows-verified-commands.txt)
and [output](windows-verified.txt). They are compile diagnostics, not executed
screen-control evidence.

## Integration and live gaps

The app consumes `MachineJoinEventSchema`, `MachineJoinLocalScreenStatusSchema`
and the supervised `join … --json` / `join resume --json` CLI. Local stdin only
accepts status/Stop; it cannot grant consent or enable input. Finite
`join status --json` reads registration only. Finite `join leave --json` revokes
transport and removes the broker record; it does not attest to screen quiescence.
Contract: [CLI](../../cli.md#lent-computer-selection). App surface is VUH-1802.
Stdin closure permanently withholds screen policy in that supervised process;
it cannot admit a later screen session even while transport remains registered.

The first landing gate passed formatting and stopped at four unnecessary quote
escapes in the synthetic fixture. [That failed gate](landing-first.txt) is
retained; the fixture uses `JSON.stringify` after the fix, with no lint or test
exclusions.
The next gate passed static checks, then found missing dependencies for the
new Minecraft workspace package after rebase. [That setup failure](landing-missing-dependencies.txt)
is retained; dependencies were [refreshed successfully](install-after-rebase.txt)
with `clankie heavy -- pnpm install --frozen-lockfile` before rerunning the gate.
Final gate results and the landed
commit are attached to [VUH-1803](https://linear.app/vuhlp/issue/VUH-1803).

Private gateway admission is Nell's clankie-ops commit
`cb5749cf08d4a15a5fff440d42e45ac138379b4b`. This landing adds no gateway route,
credential forwarding or widened outer body/wire cap. Hosted rollout remains
separate from source evidence.

Leave these owner-run acceptance checks open:

- A short task on a lent Mac, captured with local consent, input opt-in and the
  visible pet; verify permissions, exact effects and person takeover.
- The same task and visual/native proof on a lent Windows PC; Windows app
  packaging remains VUH-1796.
- Pet/app Stop during queued and in-flight input: future input must fence;
  uncertain quiescence must remain held across disconnection/helper restart.
- Hosted routing rollout and an actual hosted-to-lent-screen round trip.

After any native effect, the bounded helper conservatively cannot attest to
quiescence, even when its effect receipt was exact. Stop keeps that lease held.
Do not replay unknown input, infer recovery from process exit or use a new
helper to attest to an old native session.
