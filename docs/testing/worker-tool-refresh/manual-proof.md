# VUH-1739: Original worker refresh proof

Run after the core integrator lands and deploys the branch. This is a local
service/native-seat proof; it requires no AWS operation or voice provider usage.
VUH-1739 covers local Codex. Remote Codex and old Claude recovery are tracked
separately in VUH-1742. Current local controllers use the in-place proof below;
pre-0.6.5 worker plugins use the explicit restart fallback.

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

## Pre-0.6.5 local Codex restart fallback

Use an owned idle canary or a target with explicit restart authorization. This
procedure grants no authority to restart an existing lane.

1. Record its native thread UUID, account, cwd, plugin version, saved result and
   current receipt state. Require roster/doctor `restart needed` and the exact
   remediation command. Remote/Claude seats must not receive this local label.
2. Retain any original receipt claim. An unresolved claim/lock or service fence,
   busy native turn, unsent draft or missing saved result must refuse restart
   without another report POST or a second TUI.
3. With the receipt settled and the seat idle, run one command:
   `clankie harness restart-tools --pane PANE`. Add `--report /absolute/report`
   only when the completed result has not already been retained. Record its
   `historyId`, original `threadId`, and `resumedSeatId`.
4. Verify the same native thread UUID, saved account and cwd after native exit
   and resume. Verify the new plugin/catalog contains both peer tools. Make one
   new deliberate report and require a new stored receipt, with no replay of
   the old report. Require that roster/doctor no longer says restart needed.
5. A lost exit or resume acknowledgment remains held in tidy history. Inspect
   that exact operation; do not invoke restart again or substitute another
   thread to make the result appear successful.

The manual `SEAT_REFRESH_NATIVE_TEST=1` test uses a real owned Herdr namespace,
the production atomic CLI installer in an owned prefix, and loopback HTTP. It
proves unsupported-occupant, authorization and schema refusals with the original
shell PID unchanged and zero close/hire effects. It does not prove a successful
old-plugin native restart; retain that live canary result separately.

Other connection limits: remote Codex original-controller recovery and imported
old Claude bridge replacement belong to VUH-1742; exact OpenCode model-visible
MCP names remain unavailable through its pinned public SDK. None is a successful
local Codex proof. Lost mutation acknowledgments or crash-held claims require
exact native/process evidence, never elapsed time, receipt deletion or replay.
