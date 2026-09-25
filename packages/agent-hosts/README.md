# Agent hosts

Discovery and byte-range access to Claude, Codex, Grok and Pi JSONL transcripts,
independent of terminal placement, Swarm enrollment, and process control.
`AgentHost` exposes `list`, `readBytes`, and `runAgentTurn`; `@clankie/agent-transcript` owns parsing
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

Headless turns require the selected harness CLI already installed and authenticated
on that host. They resume saved history in a new process, never inject input into
an existing terminal. Exact session UUIDs and absolute working directories are
required; Pi uses the discovered transcript path when supplied. Claude/Codex/Pi
receive literal UTF-8 stdin; Grok uses a private temporary prompt file. No approval
bypass flags are added. Codex skips its Git-directory prerequisite when resuming
an existing session, so a session originally started outside Git remains usable.
Existing harness configuration and project instructions
still apply. The service owns quiet-time checks and one-run-per-session admission.

Each turn has a ten-minute execution deadline and at most 1 MiB of captured output
per stream (the tail). Local POSIX cancellation kills the owned process group;
a deliberately daemonized descendant that leaves that group is not covered.
SSH POSIX
runs supervise their child tree; Windows uses an in-memory .NET supervisor and
`taskkill /T`. Windows also needs its native PowerShell/.NET compilation support;
no supervisor package is installed. Temporary prompt/control files are removed
when the supervisor exits. Remote cancellation sends a nonce-scoped request over
a second SSH connection and waits for the original supervisor's receipt. If that
receipt is lost, the outcome is `unknown`; disconnecting SSH is never proof of
remote termination. The service must retain the session reservation in that case.
