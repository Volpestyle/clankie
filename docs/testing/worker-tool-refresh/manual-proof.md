# VUH-1739: Original worker refresh proof

The [local startup repair trace](../2026-10-08-local-codex-startup-repair/README.md)
records the confirmed failed-generation case and its explicit real Codex
app-server integration check. It does not replace the original-seat live proof below.

Run after the core integrator lands and deploys the branch. This is a local
service/native-seat proof; it requires no AWS operation or voice provider usage.
VUH-1739 covers local Codex. Remote Codex and old Claude recovery are tracked
separately in VUH-1742. Current local controllers use the in-place proof below;
pre-0.6.5 worker plugins show restart needed and retire naturally. The owner
chose no automated legacy restart; supported refresh and legacy diagnosis are
the VUH-1739 acceptance. No new native exit capability is required.

1. Record deployed core SHA, worker plugin version, original pane IDs, original
   native root/descendant session IDs and the native Clankie tool inventory.
   With peer messaging enabled, require `message_clankie`, `clankie_tools`,
   `clankie_call`, `list_fleet_seats` and `message_peer`. Use each original
   controller's native inventory, rather than a new observer thread.
2. Keep an original worker busy in an existing tool call. Run
   `clankie harness refresh-tools --pane PANE`. Record `skipped-busy`, then
   prove that no config/reload mutation or receipt GET occurs before the
   active call settles. After idle, verify the same root/descendants and new
   accepted catalog without a TUI restart, fork, resumed thread or lost turn.
   Local Codex returns `catalog-refreshed`: this inventory is not next-turn
   model exposure proof. In the original worker's next turn, enumerate tools
   (including Code Mode's `ALL_TOOLS` when applicable), call `clankie_tools`,
   then retain the distinct stored report receipt in step 5. Missing model
   tools remain a named gap even when the native inventory is connected.
3. Deploy through `clankie update` with the original seats still present.
   Record the service boot change, private native config version, one revision
   write, one reload and complete filtered inventories. Repeat with unchanged
   tool schemas to prove the service revision triggers refresh. Check `/doctor`
   and roster observed/expected plugin versions and runtime-behind fields.
4. With an exact retained `message_clankie` receipt, record its original ID,
   binding and fingerprint privately. Refresh. Require exactly one GET for
   that original, no POST/replay, and an exact terminal receipt before its
   claim settles. A mismatch or unresolved response must retain the claim.
5. Make a separate deliberate native `message_clankie` call carrying a new
   distinctive report. Verify the lead received it with a new stored receipt.
   Retain proof that the original TUI/controller/root did not restart.
6. Revoke peer messaging and refresh. Require both peer names to disappear
   from every loaded original descendant; stale extra names must fail native
   verification. Restore only if the owner intends peer messaging enabled.
7. Test one-seat and all-seat refresh through API, CLI/TUI and
   `refresh_worker_tools`. Revoke operator/connection authority during a
   preparation await: no ensuing native mutation is allowed. Close the service
   during that await and require the same refusal.

## Pre-0.6.5 local Codex manual retirement

No automatic or supervised quit/resume is enabled. An old seat can finish its
work and retire naturally. On the lead's explicit retirement request:

1. Confirm the exact admitted seat is idle, with no unsent draft. Retain its
   completed handoff, issue/evidence links, working directory and original
   thread reference. Verify the saved thread evidence exists on disk.
2. Reconcile any original report receipt read-only. A held or conflicting
   receipt/claim remains held; never clear it or replay its report to enable
   retirement. Retain unresolved work until the lead resolves that boundary.
3. Close the idle seat through the existing lead tidy path after harvesting its
   handoff. A missing close receipt requires inspection of that original
   operation; it is not permission to dispatch another close.
4. Hire a fresh worker with the current plugin and the retained task/handoff.
   Keep the old thread and evidence on disk. This is a new hire, not an
   automated same-thread resume or a duplicate report.
5. Verify the new native catalog and one new stored report. Original receipt
   IDs remain historical evidence and are never substituted into a new report.

Roster/doctor must label an observed pre-0.6.5 local Codex seat `restart needed`.
Refresh must not claim adoption of its unverified original catalog. The
compatibility `clankie harness restart-tools --pane PANE` refuses an otherwise
eligible production local Codex target with `native_exit_unavailable` before
any close/history intent. Terminal aliases, busy targets, and unknown draft or
ownership evidence also refuse. It is not an automated retirement command.

The manual `SEAT_REFRESH_NATIVE_TEST=1` regression uses real owned Herdr,
the production atomic CLI installer in an owned prefix, and loopback HTTP.
It proves unsupported-occupant, authorization and schema refusals with the
original shell PID unchanged, no history intent and zero close/hire effects.
Current-controller refresh evidence and the historical live retained-report
check are separate. No existing lane is restarted to prove this scope.

Other connection limits: remote Codex original-controller recovery and imported
old Claude bridge replacement belong to VUH-1742; exact OpenCode model-visible
MCP names remain unavailable through its pinned public SDK. None is a successful
local Codex proof. Lost mutation acknowledgments or crash-held claims require
exact native/process evidence, never elapsed time, receipt deletion or replay.
