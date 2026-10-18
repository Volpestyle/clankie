# PC Codex startup — VUH-2447

Tracks: https://linear.app/vuhlp/issue/VUH-2447

Base: `97c68a36d039a757d8849afa9e9a4301927e21a4`.

The shared Codex startup adds four empty resource-holder resets. The remote
launcher rejected them as foreign environment overrides before launching the
app-server. It now accepts only the exact empty resets, rejects nonempty holder
overrides, and clears inherited holders in both remote launch paths. Local
startup and remote Claude launch code are unchanged.

Remote checkout refusals now retain Git, filesystem and census errors. A live
checkout refusal names its directory; an unresolvable pane directory still
blocks advancement. Returned diagnostics are bounded and redact URLs and
credential-shaped text.

## Evidence

- `regression-before.log`: the shared-startup process-boundary regression fails
  against the original remote launcher with the reported environment refusal.
- `focused.log`: four files, 69 passed and one opt-in PC catalog check skipped.
  Covers shared startup through a real POSIX child, inherited holder clearing,
  Windows private/legacy launch contracts, nonempty override rejection, real
  Git freshness refusals and redaction, local Codex holders and remote Claude
  isolation. The child captures its environment and exits before SSH forwarding;
  this is not a native Codex hire.
- `pc-parser.log`: the PC's PowerShell `5.1.26100.9711` parsed the complete
  generated private launch script with zero errors. Its four generated reset
  assignments cleared an owned hashtable. The probe launched no server, pane or
  thread and changed no PC files.

`proof.txt` combines these logs, the exact generated Windows script parsed by
the PC, its read-only parser probe and the implementation diff. It lives in the
evidence store; `evidence.json` contains its receipt.
The root landing-gate result is recorded on the issue with its checked commit
and fixed base; it is separate from these focused checks.

## Post-deploy test plan — lead owns the real hire

1. Deploy the landed revision. Check `clankie doctor --machine pc --json` for
   the enrolled Windows/PowerShell fleet and current worker bridge. Resolve any
   bridge preparation refusal through the supported machine setup route.
2. Use a clean, inactive disposable checkout in a registered PC project, based
   on fetched `origin/main`. Leave KH2 worktrees, `rig.lock` and existing lanes
   untouched. Submit one fresh Codex hire with a new intent and assigned name.
3. Brief it to report its cwd, PowerShell version and native thread ID, run a
   tiny `clankie heavy -- node -e ...` command, and send `message_clankie` from
   its own worker bridge. Verify the visible PC TUI, native name/thread binding,
   confirmed hire receipt, tool catalog and report in the hiring conversation.
   The heavy holder must be that Codex thread, not an inherited lead identity.
4. In a separate disposable behind-only fixture owned by a live pane, verify a
   fresh hire refuses with the live checkout directory, preserves HEAD and
   creates no new worker. A missing census directory must also refuse with its
   actual path/error. Use fixture repos, not the existing KH2 lanes.
5. Smoke a local Codex hire and a remote Claude hire in separate clean owned
   directories, confirming each native bridge report. Retain receipts and clean
   up only those new owned fixtures. Reconcile any uncertain receipt before
   issuing separately new intent; do not replay a failed original hire.

## Gaps

The real PC hire, native Windows process environment, first-brief delivery and
post-deploy local/Claude smoke checks remain unperformed by this worker.
Read-only PC census still observes `wt-vuh2304` in `w18:p8` and `wt-vuh2339`
in `w18:pA`; this does not settle their historical launch receipts.
Stale allocation `1460c2eb` is tracked separately in
[VUH-2471](https://linear.app/vuhlp/issue/VUH-2471). No allocation was released.
