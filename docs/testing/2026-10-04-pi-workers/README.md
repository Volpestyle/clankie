# Native Pi workers: implementation and acceptance boundary

VUH-1582 adds a native extension control channel to the existing prepared-hire
path. Local fixtures exercise production extension and controller code without
starting Pi, a model turn, an owner session, or a second agent process. A live Mac
hire remains an explicit acceptance requirement; this document is not live proof.

## Native capability

The selected executable is the installed `@earendil-works/pi-coding-agent` 0.87.1
Node bundle. The launcher resolves the executable without running it, verifies
the package, CLI wrapper, CLI runtime and relevant bundled core hashes, and holds
their file identity across allocation and subsequent admission. The captain's
patched 1.0.0 dependency is not imported or treated as native compatibility proof.

Herdr launches the canonical Node binary and selected CLI directly as the pane's
initial argv. The shared prepared-native host checks the original direct child,
foreground PID, process birth, canonical executable/cwd, held controller socket,
Herdr binding and terminal. Pi rewrites its process title, so the selected script
comes from the service-owned initial argv and pinned files. The extension's
reported `process.argv` is corroborating runtime metadata, not independent OS
evidence or a tool-authority credential. This is not a guarantee against malicious
same-user process-memory modification.

Only `ctx.mode === "tui"` is accepted. RPC also exposes `hasUI`, so that flag is
insufficient. The live native session manager must agree on session UUID, header,
cwd, native file and session directory. A fresh session file may still be buffered;
its live native header does not claim persisted bytes. When the file appears its
actual header and inode are checked. Resume resolves an existing exact confined
native file and verifies its header before selecting `--session <file>`.

An unmanaged or hosted launch without a brief retains its existing native launch
behavior. If a prepared Pi adapter is registered, it is selected even without a
brief; capability, binary or proof failures never fall back to that unmanaged
path. An automated brief still requires a structured adapter. Saved live Pi
resumption, with or without a brief, separately requires the original controller
and exact saved-session proof described below.

## Delivery semantics

The extension uses supported `pi.sendMessage` custom messages with `display: true`,
unchanged brief text and native `details` containing the request identity. Pi's
native implementation passes these messages to `agent.followUp` or `agent.steer`;
its model conversion passes their content as user content. This supported custom
channel does not run or replace user-input transformation hooks.

The void send return is not an acknowledgement. A correlated native
`message_start` with the exact custom type, details and content confirms that Pi
pulled the message into its agent loop. It does not establish provider exposure,
model consumption, durable queue insertion, or an atomic exactly-once transaction.
Equal owner text, transformed content, an idle state and an unmatched settled
event cannot acknowledge a request.

The existing controller receipt fence is persisted before native invocation.
Missing events, socket loss, session replacement, changed file/process identity
and lost acknowledgements retain uncertainty. Nothing reconnects, resends or
starts a replacement worker automatically. A busy native memory queue may remain
uncertain until the matching native event arrives; queue insertion alone is not a
receipt. Compaction or retry boundaries without a live native run signal cannot
receive a queued custom message. Once a send has timed out, a late native history
entry can reconcile the existing delivery receipt only when its semantic request
ID, text fingerprint, original UUID, pane and exact native path all match. Equal
owner text and old receipts without those facts remain uncertain. Reconciliation
does not restore a retired controller or clear its separate pending native claim;
subsequent control can remain unavailable.

Observed extension dialogs and native project trust block dispatch. The extension
does not answer dialogs, change trust, edit the owner's draft, navigate sessions,
or claim a universal permission-state oracle. Session switch/fork/tree/reload and
shutdown retire the original channel. Abort returns success only after the
original native signal is aborted and a later native settlement is observed.
Closing control closes its listener and transports; it does not close the pane,
shutdown Pi, or abort owner work.

## History and completion

Pi JSONL remains the history source through the existing agent-transcript reader.
Native displayed custom-message entries retain their original entry IDs and
active ancestry; request metadata is not copied into displayed prose. Discovery
uses the active native session-directory/agent-directory environment. Conflicting
per-hire profile roots are unavailable before allocation.

Saved-file discovery alone cannot adopt a live session. The existing resume path
requires a fresh complete inventory of the selected Herdr fleet before allocating
a new saved-session process. An exact live match reuses only its original proved
controller, including resumes with no brief. Its verification callback rechecks
the exact saved canonical file/cwd, native UUID, original process birth, pane and
session around awaited admission; the same UUID at another path cannot qualify.
Missing control or proof callbacks, offline/unknown state, ambiguous matches, a matching
resume label or an unidentified same-harness pane in the same cwd refuse the
launch. An unreadable inventory also refuses. Only a complete inventory without
those possible writers reaches a new launch, followed by the same file/header
and process fences. This is a Herdr inventory boundary, not proof that no
independent process outside that fleet has opened the file. An uncertain initial
Pi hire remains tied to its original pane after service loss; equal transcript
text cannot recover it or authorize another allocation.

Final output is read from a bounded tail of the current native branch after
`agent_settled`, tied to the correlated custom-message entry. Intervening owner
input makes attribution unavailable. Error, abort and length stops are not
successful completion just because the runtime is idle. Existing hire/controller
origin handling owns harvesting and Discord reporting; no transcript mirror,
parallel job store, or new room-delivery path is added.

## Required owner acceptance

- Start a real native Pi worker through `hire_agent` in an owner-visible Herdr
  pane and inspect the initial brief, native session and delivery stage.
- Exercise a busy follow-up/steer, an unsent draft, an owner dialog, a session
  switch, interrupt, transport loss and service restart without duplicate sends.
- Complete a hire originating in Discord and confirm the existing origin path
  reports its native final output once.
- Browse and resume the exact saved native file in the same effective profile.
- Verify the independently owned fleet-tool projection. These control fixtures
  do not establish the two-meta native tool catalog or live tool authority.

The named operator-chat command `clankie pi` is not supplied by this worker
adapter. Existing generic hire/message/session APIs are its entry points.
