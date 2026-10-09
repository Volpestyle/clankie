# Remote lead Windows workspace creation (VUH-1927)

The live KH2 launch failed at `reserved` because workspace creation used the
service host's POSIX absolute-path check, followed by a local directory stat.
A Windows directory on the linked PC cannot pass those local checks. Launch's
bare catch then hid the cause. The latest
[VUH-1927 evidence](https://linear.app/vuhlp/issue/VUH-1927) records the two live
receipts; this change fixes that boundary, without deploying or touching the PC.

The single new integration case calls real `RemoteProjectLeads.launch`, captain,
ConversationStore, settings persistence and framed child-process pipes. Only
linked-machine discovery/approval and the SSH endpoint are fixtures. Against
original source at `78469903`, it reproduces `unconfirmed`, `failedStage: reserved`.
Against repaired source it reaches `dispatched`, persists a machine-tagged
Windows workspace, reconciles the original request without another allocation,
refuses client-authored remote scope and local captain fallback, admits the
real delegated lead tool bank, and checks redacted failure receipts and logs.
This proves the service boundary; Windows harness admission remains live proof.

Launch creates remote metadata through an internal service-only boundary after
exact workspace approval. Windows validation uses `path.win32`; remote paths
are never statted on the Mac or used as a local captain cwd. Existing local
workspace validation remains. Native delivery, reports and wakes retain their
driver path. Project attribution uses registered remote workspace membership;
local instruction reads, shell authority, attachment materialization and file
publication do not inherit the remote directory.

## Checks and provenance

All installs, formatting, tests and compilers ran through `clankie heavy`.
The same acceptance case fails on original source and passes after repair.
The focused service typecheck passes. Protocol adds only optional `machineId`.
Neighbor compilers resolve this worktree's protocol exports, not the unchanged
sibling checkout. All six ops TypeScript configurations pass. App integration,
device-session and three skin configurations pass. App macOS, mobile, web and
command-center retain `MailboxSheet.tsx:130` TS2366: `askKind` omits the existing
`verify` question purpose. The same four diagnostics occur with original
protocol sources at `78469903`, with no additional diagnostics after this change.
App HEAD: `e2e8fe28`; ops HEAD: `0e0cdef0`. No private-repo source was edited.

The final root gate's exact checked SHA, base, phase results and elapsed time
are recorded in the issue evidence.
The root gate uses its own `--changed` selection, after commit and rebase.

The original/focused captures are below the archive upload threshold (the
archive command reported no candidates). Captures, neighbor compiler harness,
original protocol snapshot and root gate report are retained under
`.local/vuh-1927b/` in the assigned worktree. The first install admission failed
with the existing heavy lock-helper `OSError (errno 9)`; normal retry succeeded.
No resource limits or timeouts changed.

## Gaps

The lead deploys the landed SHA and performs the real KH2 launch, native channel
attachment and child adoption. These checks do not claim that live proof.
