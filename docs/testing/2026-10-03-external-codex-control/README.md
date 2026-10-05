# External Codex control (VUH-1559)

The service uses the installed `codex app-server proxy` on the selected machine,
with raw WebSocket framing over its stdin/stdout, including through SSH. It reads
the exact Herdr-bound thread, requires active status, reads the latest turn, and
sends `turn/steer` with `expectedTurnId`. It never starts a daemon, resumes a
thread, answers an approval, changes permissions, or writes terminal input.
A local `--no-daemon` TUI or unavailable foreground argv never selects the default
shared daemon. A failure after sending is unconfirmed and cannot fall through to another channel.
Idle/unreachable threads use the existing native queue with explicit turn-end
wording. Owner-input/approval waits return undelivered without queueing.

## Evidence and limits

Local interface checked: installed `codex-cli 0.160.0`, `app-server proxy --help`.
Local Codex checkout `008bbd5884`: `codex-rs/cli/src/main.rs` proxy branch and
`codex-rs/app-server/README.md` confirm a raw socket stream (HTTP Upgrade followed
by WebSocket frames), defaulting to the account's app-server control socket;
`--sock` selects an explicit socket. The proxy does not start the daemon.
`request_processors/thread_processor.rs` merges the in-memory active turn into
`thread/turns/list`, even before persisted history catches up.

Deterministic checks use a real Unix WebSocket listener and a child-process byte
proxy. They cover exact-turn fencing, inactive/mismatched thread refusal, owner
approval, pre-send disconnect, post-send uncertainty and no duplicate queue.
These transport checks are not evidence of remote Windows or SSH TUI acceptance.

Live local acceptance: an owned visible Herdr scratch TUI (`w3Z:p7`) used a
separate explicit Unix app-server socket, then the installed proxy connected
as another client. Exact thread `01a0ffd4-b43b-7c42-997c-0306c82d1389`, turn
`01a0ffd4-bebb-7682-bf80-7d2f339aa799`: steering acknowledged in 13 ms while
active, and the TUI replied `STEERED-1559` instead of `ORIGINAL-1559`. No
terminal message input was used; focus stayed unchanged and only the owned
pane/server were closed. This proves the reachable-server route, not fresh
shared-daemon identity. A populated draft and actual approval dialog were not
part of this live run; approval behavior is covered deterministically.

## Herdr identity and local fleet authority

VUH-1398 remains a trade-off. Herdr's Codex integration v8, both shell and
PowerShell assets, reports `session_id` from a SessionStart hook using inherited
pane/socket environment. A shared server's hooks do not reliably inherit the
particular client pane's identity. This change accepts a valid existing Herdr
session binding even when the TUI has no open rollout; it refuses conflicting
rollout identity and does not guess from history. Fresh daemon panes without a
valid session binding remain unavailable for this route. This is source inspection,
not a fresh successful shared-daemon identity test.

Outbound control is owner-authorized service behavior. It grants no incoming MCP
membership: VUH-1548 shared-daemon membership still fails closed. Private hired
servers keep their existing proof and startup trust handling (VUH-1551).

## Windows owner decision

VUH-1563 native Windows verification belongs to **James, on the PC only**.
The fast worker checks execute the shared TypeScript argv classifier and
loopback control fixtures. They do not execute the C# kernel producer or prove
its runtime parity. James's PC run must verify the native argv projection,
including a recognized app-server with an unknown trailing flag, alongside
the private backend/TUI and default-home queue paths. The opt-in installed
Codex suite is separate evidence; its skipped cases do not establish native
Windows acceptance. Workers must not enable this lane or make live PC calls
as part of the focused gate.

Proposal for James: retain the elevated-shell `--no-daemon` workaround for now.
Removing it globally would exchange reliable private pane identity and local
fleet proof for a reachable shared server, while daemon identity and elevated
Windows behavior still need live verification. If immediate steering on the PC
is required, test an explicitly reachable server with one owned scratch TUI first;
use a Clankie-managed exact-session resume only when the current session is idle.
No dotfiles change, grant, service restart or daemon activation is included here.

A second live check exercised the integrated `createHerdrWatchRunner` →
`createFleetSeatControl` route with an empty adapter map. The foreground Codex
argv supplied its exact `--remote unix://…` endpoint; no default-daemon substitution
occurred. Thread `01a0ffdc-04bd-7f31-bc9a-463ab63698a7` accepted the steer in 90 ms
and its TUI showed the changed final reply. The test explicitly reported the
scratch TUI's known thread to Herdr: automatic hook discovery was absent and is
**not** claimed fixed. An initial unbound probe correctly returned undelivered.
All owned scratch panes/servers were closed. Explicit non-Unix remote endpoints
are unsupported by this proxy route and are not replaced with the default daemon.
SSH also inspects the exact remote pane's foreground arguments. It targets that
account's default shared socket or the explicit Unix endpoint, and refuses
private `--no-daemon`, unknown arguments, or unsupported endpoints.

Local/SSH active-turn acceptance and draft preservation must be reported separately
from fixture results in the issue evidence. SSH acceptance is not claimed here.
