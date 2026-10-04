# Protected native Claude collection seam

This is source engineering with deterministic process/filesystem fixtures. No
Claude CLI, credential, account, provider, model, Docker, probe or evaluation ran.
The native arm remains unsupported. The collector cannot issue launch or quota
authority, and the existing Codex capability cannot authorize a Claude binary.

## Actual boundary

`startNativeClaudeCollector` requires the real `LeadContainer` in native mode and
its real `NativeOwnerAttachment`. The existing private runtime capability reader
must bind `/opt/claude/bin/claude` to the selected executable hash. Native `pipe`
still enforces the private image/daemon/runtime capability. No imported JSON,
selected artifact label or fixture flag supplies that origin. The
[Claude runtime controller](native-claude-runtime.md) now implements a separate
private image/control capability and original-lifetime launch selection; actual
Linux/native acceptance and vendor provenance remain unavailable.

The collector accepts only the controller's in-memory selection token. Before
exec, the immutable pane launcher retains the original bubblewrap child pidfd;
the controller independently proves that launcher's peer and shell through the
actual Herdr pane process API. After exec, the controller checks original lifetime,
selected executable/cwd and native foreground membership before activating the
token. Environment/session/argv/TTY labels only constrain that already-owned
lifetime; they cannot select or adopt a process. Every data frame awaits fresh
controller binding, while the passive ready frame only stages the hook listener.

The capture helper reads only the original selected PID/start ticks. The executable
is hashed through its actual `/proc/PID/exe` descriptor; later checks retain its
device/inode/size/ctime identity. It rejects PID reuse, changed argv/config/cwd,
replaced executables and headless selections. Every hook uses Linux Unix socket
peer credentials and a bounded ancestor chain to that root; all ancestor lifetimes
are rechecked. Snapshots recheck the selected root around reads and transmission.
These are process observations, not account attestation.

The whole native process, including Read/Edit, is inside the Claude-specific
kernel boundary. Private controller files/sockets and parent processes are absent;
the fixed hook-input socket is intentionally available as untrusted input.
A native
process or descendant able to write transcript/hook bytes can forge their contents;
a valid peer chain does not prove an official hook fired, nor that all children or
provider requests were seen. Every exported report therefore remains
`authoritative: false`, `complete: false`, `launchAllowed: false` with no account-wide
token total.

## Collection and retention

The first-party [hook reference](https://code.claude.com/docs/en/hooks), checked on
2026-10-03, documents the registered names: SessionStart, UserPromptSubmit,
SubagentStart, SubagentStop, Stop, StopFailure and SessionEnd. The writer stages a
fixed Python hook bridge and explicit settings in the fresh private collector
control directory. A future verified runtime must select those settings; this does
not modify or launch the existing prepared plan. The documentation contract is not
proof of compatibility with the selected binary. Unsupported, missing or mismatched
hooks remain gaps. StopFailure is an observation only; hooks cannot provide the
physical-request budget gate.

Hook input reaches a controller-created Unix socket. The helper waits for the
controller's durable append acknowledgement before replying. The host keeps only
the observer's sanitized lifecycle fields and original-payload hash/byte count.
It never retains hook prompts, responses, supplied paths or arbitrary extras.

Root/child transcript paths are derived from the selected cwd/session and bounded
native `agent-*.jsonl` names, never from hook `transcript_path`. The reader walks
no-follow directory handles, opens nonblocking no-follow regular files, refuses
hardlinks and rechecks exact descriptors and named paths. Concurrent appends may
extend a file; rewriting or truncating a captured prefix, changing its inode, losing
a previously seen file, or replacing a directory stops collection with a gap.
The current fixed native path convention still needs selected-version verification.

The host creates a fresh private evidence directory outside **every canonical
inspected runtime mount source**, never mounts it into the runtime, and appends a
hash-chained journal. Raw transcript snapshots remain private files there; exported
summaries and the journal contain hashes and metadata, not transcript bodies.
The boundary protects retention from the contained runtime; it does not claim to
resist an unrelated privileged host process or the owner modifying local storage.

Bounds: 64 KiB per hook, 1 MiB aggregate encoded hook input, 10,000 hooks, 16 MiB per
transcript, 32 MiB per capture batch, 32 child files, 64 MiB cumulative retained raw
snapshots, 8 MiB/20,000 journal records, one acknowledged protocol frame at a time,
and a socket backlog of eight. Directory scans stop at the first entry over their
cap (32 children or 512 process-directory entries), without materializing the
remaining inventory. Initial executable hashing reads at most its initial size
(up to 512 MiB) plus one growth-detection byte, checks a five-second deadline around
each read, and rechecks descriptor size/ctime afterward. The deadline is checked
between synchronous reads; the controller watchdog handles a stalled helper. Missing root proof after ten seconds, a stalled
five-second helper heartbeat, failed owner proof, malformed frames, capacity loss
or helper exit triggers and awaits exact container-wide stop. Failed stop receipts
remain uncertain and cannot become a successful closure. A terminal partial batch
is reported as missing coverage. Owner/process checks and all timers are bounded;
no callback relies on a model-written claim to keep collection alive.

## Remaining work

Verify the implemented image/control and original-launch path on the actual
selected native artifact, including official provenance, effective hook settings,
process/path compatibility and descendant-wide stop. Live collection remains held.
Provider identity/quota observation, physical-request admission and native
child/index routing remain separate missing engineering. Retained filesystem
claims and their hashes cannot close any of those gaps.
