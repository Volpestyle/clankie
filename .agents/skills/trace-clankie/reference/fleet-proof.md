# Fleet proof: gotchas

Reading fleet proof alerts and native process/pane refusals.

- **Start with the metrics.** `clankie metrics --fleet` and its coverage start;
  compare rates only within a settled runtime. In the private service log, join
  `fleet.local_proof.refusal_context` and project-stage diagnostics by
  `requestId`. The fixed route and `operation` distinguish fleet admission from
  project membership. `claimedPane` and `claimedBridgeId` are caller claims;
  `callerPid` plus `callerBirth` comes from a kernel observation. Check
  `callerAttribution` and `callerObservedAt`: a previous observation is
  historical, and `unknown` does not identify a sender. A project
  pane-not-found is distinct from harness, launcher, foreground,
  process/session/binding and transport failures. See `docs/cli.md` under
  `metrics --fleet` for the bounded diagnostic sampling.

- **Quiet intervals need two sources.** Aggregate proof alerts appear as
  conversation service notices. Caller-specific alerts can go directly to the
  lead's native mailbox without a conversation journal entry. Before claiming a
  quiet interval, check the lead's matching native transcript and delivery
  receipts as well as retained aggregate notices.

- **`launcher_mismatch`.** Compare the foreground group leader with the actual
  harness: `clankie claude` leaves its Node launcher in front of a direct Claude
  child. Only the exact installed launcher/command and kernel-proven child chain
  are supported; never exempt a mismatch just because the pane looks healthy.
  ESRCH/EBADF retry diagnostics from the global process/FD scan are not terminal
  refusals; join the final proof result before diagnosing an outage.

- **`launcher_unavailable` on Claude.** Check the service's PATH: prepared panes
  put Clankie's shell shim before the actual Claude binary. Project proof
  resolves past those shims using the launcher's real-Claude lookup; the shim
  itself never proves membership. A launcher refusal is not evidence of a failed
  socket lookup. An empty or all-relative service PATH supplies no installed
  launcher; proof never falls back to an executable in the working directory.

- **Idle Codex panes.** Distinguish persistent worker discovery from temporary
  `mcpServerStatus/list` snapshot clients. A snapshot may end its bridge
  immediately after `tools/list`; bridge health must finish before that
  response, or its fire-and-forget notification can fail proof after the caller
  exits. This is a caller-lifetime defect, not authority granted by an idle pane
  or reason to mute alerts.

- **Remote Windows `remote_pane_required`.** Compare the kernel's loaded image
  with the independently installed launcher before blaming workspace grants. A
  replaced Claude image may still run as
  `claude.exe.old.<timestamp>.<updater-pid>`; several workers can share that
  image, so its suffix need not equal the worker's PID. The observer admits only
  that launcher's exact predecessor renamed during the worker's lifetime; native
  PID/birth, pane ancestry and socket ownership still have to match. A bridge can
  reconnect to the new fleet port yet fail this native proof: connected tools can
  work while both mailbox polling and reports are refused. Readoption does not
  repair a failed native proof. A host-side probe fix can help an existing bridge
  that keeps polling; deploy it through the scheduled runtime restart, then
  observe recovery without replaying uncertain mail or touching a busy pane.
  Remote process/pane admission and project workspace membership are separate
  checks. A read-only process observation without the original request socket
  does not prove successful native report binding.

Do not infer the historic sender from today's connected processes. Retain
actual PID/pane/socket details privately and publish sanitized counts and stages.
