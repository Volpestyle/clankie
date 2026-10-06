# VUH-1739: Original worker refresh proof

Run after the core integrator lands and deploys the branch. This is a local
service/native-seat proof; it requires no AWS operation or voice provider usage.
Keep VUH-1739 open until the unsupported cases below have a supported path.

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

Remaining acceptance gaps: remote Codex has neither an isolated native config
target nor durable original-controller recovery; imported old Claude bridge
code has no supported original-mod replacement path; exact OpenCode
model-visible MCP names are unavailable through its pinned public SDK. These
must not be recorded as successful proof. A lost native mutation acknowledgment
or crash-held claim must be reconciled through exact native/process evidence,
never elapsed time, receipt deletion or mutation replay.
