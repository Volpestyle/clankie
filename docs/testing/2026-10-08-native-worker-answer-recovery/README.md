# Native worker answer recovery (VUH-1782)

The owner observed `message_seat` refusing Teo's Codex async question
`call_9f7ef57175c144eebe51eb3a8e35f483` with
`No pending-question control channel is available`. Read-only native process
inspection confirmed his TUI used a dedicated `--remote unix://` socket.
No answer, resume, interrupt, restart or terminal input was sent to his session.

The question path attached only through the launch adapter's in-memory
controller map. Ordinary messages already had an external native connection
path, but questions and owner-question escalation had none. Losing that map
reproduces the unavailable answer channel while the original native worker
still lives. The exact reason Teo's controller was absent remains unverified;
this evidence does not claim a historical service restart.

The question-only recovery connection checks the exact pane, native thread,
foreground PID and observed dedicated Unix endpoint. It requires the original
thread to be loaded on that server and reads its structured async questions.
It does not launch or resume a thread, choose an account daemon, queue input or
interrupt work. Existing authority and owner gates remain in the answer path.
Answers retain the function call ID and every native question ID, use an
attributed native user message, and confirm the matching persisted receipt.
A durable claim is shared by live and reconnected controllers, precedes dispatch,
and survives restart when acceptance is uncertain. Repeat calls preserve the
original `unconfirmed` outcome while sending no replacement. The fallback does not restore normal controller control or native
synchronous server requests.

The existing VUH-1809 owner ask store and app mailbox require no new UI:
Clankie escalates the observed question by ID; `input_list` exposes it and
`input_answer` returns the owner's answer through the recovered channel. The
owner ask retains its immutable session/request binding and uncertain claim.

Integration coverage uses the installed Codex 0.160 protocol fixture over a
real Unix WebSocket server and the real Clankie transport, schemas, native
question parser, durable journals and owner conversation store. It discards
the launch controller registry while leaving the original native server alive.
It verifies lead delivery on an active turn, owner-mailbox delivery and exact
retry, idle answer dispatch, missing loaded-thread proof, receipt loss across
restart, changed occupants, owner gates, wrong question IDs, final socket
replacement and concurrent answers. Queue and terminal fallbacks fail the
test if invoked. Native TUI/model execution and iPhone/iPad presentation are
not claimed.

VUH-1782 remains open for its broader app/World acceptance: direct worker
question presentation and Send Clankie navigation, visit/home transitions,
native custom-rule UI, real harness and iPhone/iPad proof. Remote or daemon
question reconnection and synchronous-controller restoration are separate
unsupported recovery cases. No simulator was booted or borrowed.
