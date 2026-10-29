# VUH-2825: finite Claude root hook events

This slice follows the source `11e8d85a` implementation, which already added blocking
integration status, exact-heavy retention, Codex native activity and Claude child
activity. It adds finite root events, not complete quiet-turn coverage.

The real worker hook helper reports UserPromptSubmit, all-tool PreToolUse and
PostToolUse with an observation timestamp and optional child agent ID. The real
HTTP seat route validates the native process admission, session and process-birth
proof; the service re-proves the owner before the simulator manager advances that
exact root holder's explicit-use clock. An event gives at most one configured idle
window from its own timestamp. Stop, StopFailure and SessionEnd give no time.
No cached open-turn flag exists. Esc needs no closing hook to permit expiry.

The service/governor integration runs with scratch HOME/XDG and real kernel process
identity, authenticated TCP and the public simulator CLI. Native discovery and
CoreSimulator are subprocess surrogates; no actual harness, live pane or simulator
was started. The original-native timer/child tests remain. The new cases cover
finite root expiry, replay, delayed/stale/future events, Stop/failure/end, root/child
isolation, wrong session and denied admission. A shipped-helper case covers actual
metadata transport and strict-old-host fallback. The first red run on old source
fails at the strict schema boundary; an implementation-removal mutation also
fails at the retained-lease assertion. Logs and final exact-head checks belong
in evidence.json and the issue, not inferred from this record.

Worker 0.6.22 new registrations require a new or explicitly reloaded session.
No existing seat is reloaded or restarted by this patch. Older services receive
legacy UserPromptSubmit/PreToolUse after their definite HTTP 400 rejection; unknown
PostToolUse is ignored there. Old hooks without event timestamps grant no time.

Remaining slices: a positive current root-turn snapshot tied to session/process/turn
that becomes idle on interrupt; a general process-held simulator path for long
non-heavy background waits; lead rollout/runtime proof; complete post-rollout UTC
worker foreground-sleep comparison. Existing exact-holder heavy full/light/server
work retains its simulators, but plain background process liveness does not.
Never model-side sleep/touch loops. Existing baseline is 547 known-worker sleeps/day
(October 19–24); partial days and missing transcripts are not zeroes.

Native lifecycle references: [Stop omits interrupts](https://code.claude.com/docs/en/hooks#stop)
and [plugin updates require reload/new sessions](https://code.claude.com/docs/en/plugins/loading).

Final boundary check: 29/29 tests in four files pass (35.26s), including the
existing native catalog and question/permission integration checks. Current-main
blocking integration status and existing child renewal passed 2/2 (39.04s).
Root landing gate, independent review and installed delivery remain pending.

The response-hold regression also proves renewal happens before a hook waits for
its handler's response (for example, AskUserQuestion). On the first candidate,
the held response let the original lease expire; moving the admitted finite
event ahead of that wait fixes it. The timestamp still gives only its original
idle window, never the response/answer time.

Review revision 3 addresses the hook contract and per-tool cost. AskUserQuestion
has its own long PreToolUse registration; the disjoint ordinary PreToolUse and
PostToolUse registrations have five-second native limits and two-second HTTP
limits in both helpers. A stalled real HTTP service releases both ordinary
helper paths within five seconds; the question path remains pending beyond that
ordinary HTTP deadline and completes after the handler is released.

The resource path first looks up reservations for the exact root holder/pane/
occupant/fleet. An empty lookup performs zero resource seat resolutions or owner
proofs. Admitted ordinary hooks also bypass captain conversation-state handling.
Native process admission still runs; this does not remove the two Node helpers.
Five measured Pre/Post pairs per condition, including both cold helper processes,
kernel-authenticated TCP, the real HTTP route, manager and governor, added a median
370 ms per tool with a lease (observed maximum 389 ms), and 361 ms without a lease
(maximum 365 ms). These are local boundary measurements, not installed fleet
latency: native discovery and simulator operations are surrogates. Ordinary hooks
bypass the captain; question/lifecycle handling is a stub. The pre-feature baseline
has no ordinary-tool hook calls. No claimed model-token saving is inferred from
these timings.

The helper stamps its wall clock at invocation, not Claude's event-emission time.
A linked host clock ahead of the service fails closed. The delayed-event case now
sends an older in-window event after a newer one and checks the newer deadline;
it guards against shortening the lease as well as extending it by replay.

Revision 3 focused checks: 24/24 tests in four files pass (51.78s); the separate
latency probe passes (one test, 7.87s). The first revision-3 run had a fixture-only
403 on the operator CLI timeout path; the explicit scratch operator route was
corrected before the passing run. The worker native-admission path was unchanged.

Mutation checks: removing the monotonic last-use guard fails the newer-deadline
assertion (the older event expires the lease early). Restoring the long ordinary
PreToolUse HTTP timeout fails the stalled-host case: the fixture's six-second
process cap kills the helper instead of its own two-second best-effort release.
Both sources were restored after each negative run. Service and TUI typechecks
pass (176.84s and 55.63s), as do scoped lint and plugin generation.

Revision 4 supersedes the revision-3 candidate: the lead rejected paying about
361 ms on every no-lease tool call. Ordinary Pre/Post hooks are now async; question
and permission hooks remain synchronous. A shell-only, socket/pane-indexed hint
holds the exact root holder ID. The lease journal writes it on grant/update and
removes it on release/expiry. The shell atomically consumes it before Node/HTTP;
a valid update re-arms it. A stale hint costs one helper; missing hints fail closed
and leave the ordinary finite expiry unchanged. A child event may re-arm a known
root reservation without changing its deadline. The hint never grants authority.

Before/after added wall latency per tool (both Pre and Post commands, five samples
per condition): no lease, 361 ms median / 365 ms max before, 7 ms / 8 ms after;
with a lease, 370 ms / 389 ms before, 373 ms / 395 ms after. The after no-lease
measurement waits for both shell commands to finish, a conservative bound on
async command launch, and meets the lead's ~20 ms median bar. No no-lease request
reaches HTTP, resource resolution or Node. The registered async behavior is checked
in the plugin contract; this is not a live Claude scheduler/reload measurement.

Background CPU per tool is measured separately over one Pre/Post pair. With a
lease: 200 ms helper process trees, 11 ms service/driver, 140 ms native admission
subprocesses, 0 ms rounded in the persistent native observer: 351 ms total. No
lease: all components round to 0 ms, not a claim of literal zero work; the shell
pair completes in 7 ms median wall time. Re-running the former ungated Node path
without a lease costs 315 ms CPU (190 helper, 5 service/driver, 120 admission).
Helper/admission CPU uses time(1), native observer CPU uses ps, at 10 ms precision;
service/driver uses process.cpuUsage. Native discovery and CoreSimulator remain
explicit surrogates. These are local boundary measurements, not installed-fleet
CPU or token-saving claims.

The final functional run passes 24/24 in four files (57.52s). A separate final
latency/CPU probe passes (7.12s). The initial R4 fixture used a link selector rather
than its proof's real socket for the hint path, then a child event consumed the
root hint without re-arming it; both failed checks were fixed before this pass.
The test verifies hint grant, release, expiry, child non-renewal, stale consumption,
and no-lease zero-request behavior. All reports retain the two-second/five-second
limits. No running session has been reloaded.

Removing the shell hint gate fails the zero-request assertion (24 requests instead
of the prior 12); restoring the exact shell source preserves the passing probe.
Service typecheck passes in 181.13s, fleet-resources in 0.75s; scoped lint and
plugin generation pass. Root gate and new independent review remain pending.

Revision 5 fixes two R4 recovery defects found by independent review. The shell
now retains its atomic claim while the Node helper runs. On exit it restores the
hint without overwriting a newer hint, except when the admitted service explicitly
returns `rootLeaseAbsent: true`; only that definitive result retires a stale claim.
Timeouts, connection errors, refused admission, old/unknown responses and admitted
non-renewing events leave later hooks able to retry. No renewal is inferred from
the hint or from a failed request. The child-only empty journal update is removed.

Release/expiry hint cleanup is serialized with grants and checks all remaining
reservations for the holder, pane and native socket. Ending one device no longer
disables renewal of another. Both new regressions fail on R4 (2/2 red), then pass
on R5. The stalled-host regression also now requires a later request to renew.
The two-lease fixture uses the real governor to reserve its second device, then
the real manager/CLI to release the first and the shipped hook to renew the second;
CoreSimulator remains the explicit surrogate. The reference discloses that the
shell's CLANKIE_STATE/HOME hint root must match the governor's OS-owned registry.

R5 focused check: 26/26 in four files (69.53s). The measurement in that run,
concurrent with governed typechecks, remains below the no-lease bar: 15 ms median /
17 ms maximum per tool, with zero HTTP/Node work. With a lease it measured 595 ms /
779 ms in the background. CPU sample: 512 ms with a lease, 1 ms rounded without;
the ungated no-lease comparison in the same run was 518 ms. Component breakdowns
and the prior R4 measurements are retained in the evidence; host-load differences
are not attributed to this source change. These remain boundary measurements,
not installed-worker acceptance. The lead's live closure check still requires a
fresh Claude worker session after deployment, without reloading existing seats.

Service typecheck passes (178.20s) and fleet-resources passes (0.99s), with scoped
lint, plugin generation and shell syntax also passing. The first service typecheck
reported optional-field types in the new fixture; those were annotated before the
passing run. Both typecheck logs are retained, without calling the first green.

Revision 9 repairs the test design exposed by R8's full landing gate: all static
checks and 24 typecheck tasks passed, then the original native-child case hit its
30-second limit. A lower-load diagnostic copy completed in 16.71s: 52 IPC replies,
50 helpers (246.5ms median, 378ms maximum) and 144 parent subprocesses (76ms median,
88ms maximum). Nested timings overlap. The untraced failing run does not establish
whether a specific boundary stalled. An R8 rerun was interrupted on the lead's
decision and is not a green result.

The case is split into retention/cadence and refusal/lifecycle, each still limited
to 30 seconds. All 19 assertions and all 44 heartbeat iterations remain. The
replacement fixture advances one logical millisecond before its manual producer
report, preserving the original new-instance ordering independently of the long
retention scenario. Failure-only diagnostics retain a bounded phase history with
real UTC and elapsed time, helper PID, stdin completion, admission and simulator
boundaries. The latency/CPU scenario does not enable tracing.

The normal suite passes 10/10 (64.06s test time). Two deliberate diagnostic copies
withheld helper stdin; both failed at the unchanged 30-second test limit and
reported the pending exchange/helper/withheld-input stage. Their executable copies
were removed; the exact sources and red logs remain in the R9 evidence bundle.
The latest no-lease check is 7ms median / 8ms maximum with zero HTTP/Node work;
held-lease CPU is 338ms in this sample, not a claimed improvement over earlier
host-load measurements. Root gate and R9 independent review remain pending.

Delivery gaps remain: SIGKILL can orphan a claim; held-lease hooks consume real
background CPU (about 430ms per pair in independent review); live Claude async
scheduling and EPIPE need a fresh session after deploy. The documented registry
root mismatch fails closed, orphan claims/directories are not pruned, and the
native session/process defense-in-depth guards lack dedicated mutation failures.
Quiet thinking or a long non-heavy call beyond the idle window still requires a
positive interrupt-aware native signal. The lead owns rollout, fresh-session
verification and the before/after fleet waiting measurement.

Revision 10 fixes a rollout bug found by the payload audit. R9's full gate
passed static checks and typechecks, including the split native-child suite
(10/10, 74.866s), then failed on an old exact UserPromptSubmit body expectation.
The new tests validate the canonical observation time and its reuse for receipts.

A strict older host accepted the initial legacy fallback but rejected receipts
that still contained the original metadata, leaving owner questions unconfirmed.
Both helpers now retain the accepted body for message/question receipts. Four
real-HTTP legacy cases fail before the fix; the focused check then passes 19/19.
An old plugin without an observation timestamp remains admitted by the new
service, without renewing its root lease. The new metadata remains optional.

The audit searched all hook event bodies across apps, integrations and packages
(158 files, 55 direct tests), then ran their union with the fresh changed-file
selection and filesystem consumers: 918 files, with bail disabled. All 55 direct
hook consumers pass. The full audit remains red: 880 files pass, 37 skip and one
file fails; 7,845 tests pass, 102 skip and two fail. Both failures are integrate
scratch/reclaim assertions outside hooks, under isolated base investigation.
TUI typecheck passes in 86.75s and service typecheck in 309.14s. This audit is
not a green landing gate. R10 review and its root gate remain pending.
