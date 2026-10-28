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
