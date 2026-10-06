# Native sender and completion repair checks

VUH-1527, 2026-10-06. Branch `tess/vuh-1527-remote-channels`, based on deployed
`origin/main` `4124acab` and evidence checkpoint `4f5513ee`.

## Source result

An unavailable or malformed loaded-thread inventory now refuses that request
without permanently deleting the original prepared Codex registration. Every
later request repeats the original fleet/link, kernel process lifetime, shell,
socket, occupant, backend, and sole-thread proof. A complete contradictory
inventory still revokes the registration permanently. A missing `nextCursor`
does not prove a complete inventory. The private TUI must have the native `tui`
role and point to the exact registered loopback backend port.

Worker reports and peer discovery share that sender proof. The captured Windows
census and real RPC regression pass this boundary. The precise reason the earlier
live bridge first lost its registration is unproven: this candidate repairs a
demonstrated permanent-revocation defect and narrows backend association; it does
not claim the earlier live refusal has already passed.

Hire adoption and remote census now use the same fleet-prefixed subject formatter.
This prevents the original hire's persona conversation becoming offline when the
next census creates a second persona for the same worker. Existing personas and
legacy allocations are not renamed, adopted, relaunched, or rewritten.

Accepted owner Codex follow-ups automatically persist a completion watch for the
accepted native turn ID. Earlier completions cannot settle that watch. The final
wake checks current native occupant and current persisted owner. Native harvest
claims survive watch removal and service restart, so reconciling a stable receipt
cannot wake the lead twice. A generic first-hire watch checks for a superseding
exact watch again at acceptance. Peer messages create no owner wake. Missing
original control leaves completion explicitly unverified.

Discord-owned harvests keep the original watch through the final guarded native
admission, using the existing outbox acknowledgment/Pi admission callbacks.
The reply remains asynchronous. Actor/route authority is revalidated after the
awaited final guard, so a delayed census cannot remove its own watch or preserve
a revoked actor's right to receive that wake.

## Verification

The worktree has a real independent frozen-lockfile install, with no dependency
or cache symlinks to shared trees. Heavy commands used
`~/.herdr-handoffs/clankie-backlog-20261003/bin/heavy`.

- **214 distinct focused tests passed across eight files.** The initial six-file
  run passed 191: `remote-codex-seats.test.ts`,
  `remote-project-proof.test.ts`, `remote-native-sender.integration.test.ts`,
  `codex-hired-seat-protocol.integration.test.ts`, `codex-seat-hire.test.ts`, and
  `herdr-watch.test.ts`, under `apps/clankie/test/`.
  The final Discord acceptance delta passed 22 tests in `captain-room-seat.test.ts`
  and `conversation-provenance.test.ts`. A final unavailable-controller regression
  added one test; all 10 tests in `codex-hired-seat-protocol.integration.test.ts`
  passed on that revision.
- The new sender regression uses the [actual PC producer golden](pc-sender-probe.json)
  with a real WebSocket/native RPC client. Captured kernel facts are replay data;
  they confer no live registration or current socket authority.
- Completion regressions exercise real native RPC: old completion vs new turn,
  a generic wake held before steer acknowledgment, stable receipt reconciliation
  after removal/restart, unavailable original control, peer output, changed
  occupant at final acceptance, delayed Discord acceptance/actor revocation, and
  hire → raw fleet census → persona → child-conversation native delivery.
  Host allocation is preallocated by the fixture; this does not test SSH admission.
- Clankie and agent-hosts typechecks passed through the heavy limiter; scoped
  `oxlint --deny-warnings`, formatting, `git diff --check`, and all local links
  in 451 Markdown files passed.
- [Independent native security review](SECURITY-REVIEW.md): **approved**.

No full `pnpm check`, eval, simulator, desktop action, PC account/config change,
or shared process restart ran.

## Diagnostic PC evidence and cleanup

An explicitly new diagnostic intent `e6786f92-826c-411f-96b5-5fcce05b33b1` created
only `pc/wE:p2` and its empty root `pc/wE:p1` on runtime `4124acab`. The initial
hire reply became `start_unconfirmed` after an SSH reset, while its original
native brief ran. It was never resent. A separately admitted native follow-up
captured the process/socket census: bridge Node PID `332796` descends from
original backend PID `580892`; visible TUI PID `775048` uses port `58160`;
shell PID `45644` has the same exact native/Get-Process birth timestamp.
The idle expired TCP sample had no owner and correctly grants nothing.

Both owned panes were closed through native control/verified empty-shell cleanup.
[Before/after census](pc-cleanup.json) proves the exact five pre-existing panes
are unchanged, neither original native process survives, and the Codex config
source and SHA-256 are unchanged. These observations do not grant control of
any remaining pane.

Diagnostic receipt `f256a90b-6acc-4dc6-a990-188df6a232a5` is now retained as
**abandoned**. [Recovery results](diagnostic-receipt.json): delivered recovery
refused `Exact original channel receipt is unavailable.`; the first authenticated
abandoned recovery hit `fleet_command_failed` / SSH session refusal. A later
authenticated recovery succeeded: host census proved the original allocated
`pc/wE:p2` absent, with five remaining panes, 602 processes and four sessions.
No original brief was resent, receipt file deleted, or legacy allocation adopted.
Cleanup alone was not used as receipt settlement.

## Delivery gap

After this candidate lands and deploys, use a **new** intent and owned Codex panes
for hire → brief → follow-up → completion → peer message plus tracker isolation.
Verify native worker reports, same-fleet peer discovery, child conversation
delivery, and the exact hiring lead's follow-up completion wake. Clean up those
panes. VUH-1527 remains In Progress until that live evidence passes.

Claude-seat acceptance awaits James's PC `/login`. Hand-started reply and owned
SSH-loss checks remain unperformed. The diagnostic SSH session-reset observation
is distinct from a native TUI reconnect failure; no new VUH-1738 reconnect result
is claimed.
