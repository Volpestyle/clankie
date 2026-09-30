# Agent hosts

Discovery and byte-range access to Claude, Codex, Grok and Pi JSONL transcripts,
independent of terminal placement, Swarm enrollment, and process control.
`AgentHost` exposes `list` and `readBytes`; `@clankie/agent-transcript` owns parsing
and pagination. Modification time describes a file, never proves a live agent.

The local reader uses the current user's `.claude/projects`, `.codex/sessions`,
`.grok/sessions` (only `chat_history.jsonl`), and `.pi/agent/sessions`.
Clankie's own captain history is not a discovery root.
Named SSH hosts use those same directories beneath the remote user's home. POSIX
hosts need standard `sh`, `find`, `stat` (GNU or BSD), `tail`, `head`, and `base64`;
Windows hosts use Windows PowerShell and .NET. No Clankie or Node installation is
required remotely. Custom harness history roots are not supported yet.

Owners configure `agentHosts.connections` through `clankie agents hosts`; a host
has `id`, `ssh` (an OpenSSH destination or configured alias), and `shell`
(`posix` or `powershell`). Authentication, ports and jump hosts belong in the
owner's SSH configuration. Calls use batch authentication and normal host-key
verification, with a 10-second connection and 30-second read command deadline. The
reserved `local` host needs no configuration. An unavailable host never falls
back to another one.

Listings return at most 1,000 files (100 by default), ordered newest first.
Discovery currently scans history directories on each request. Reads return at
most 4 MiB per call and are confined to transcript roots; canonical local/POSIX
paths cannot escape through a symlink and Windows reads reject reparse points.
These checks prevent arbitrary file reads through transcript references; this
is not a sandbox against another process with the same account racing file
replacement. Transcript content remains untrusted input.

Tests run POSIX commands against a temporary home, exercise local path boundaries,
and inspect encoded PowerShell commands through a fake SSH runner. The initial
PowerShell implementation was additionally checked against a live Windows PC:
discovery, byte-range reads, and outside-root refusal. Tests do not require that PC.

Reading never starts or resumes a harness. Continuing a session is the seat's
job: a hired seat stays the real interactive harness in its Herdr pane (ADR 0203).

## Seat adapters

`seat.ts` is the harness-adapter seam (ADR 0187 amendment, VUH-1458). A
`HarnessSeatAdapter` starts a hired seat in its herdr pane (`SeatView`) as the
real interactive harness, and controls it through the harness's own extension
points: a `SeatControl` with `send` acknowledged by the harness, `settled`
completion, `interrupt`, and `close`. `attach` reattaches by the harness's own
session id after a service restart. Failures are typed outcomes; `blocked`
names an owner decision (such as approving a channel), and the hire path then
falls back to terminal delivery and says why. The Claude adapter lives in the
service (`apps/clankie/src/captain/claude-worker-seat.ts`), as does Codex's.
