# Agent hosts

Read-only discovery and byte-range access to Claude and Codex JSONL transcripts,
independent of terminal placement, Swarm enrollment, and process control.
`AgentHost` exposes `list` and `readBytes`; `@clankie/agent-transcript` owns parsing
and pagination. Modification time describes a file, never proves a live agent.

The local reader uses the current user's `.claude/projects` and `.codex/sessions`.
Named SSH hosts use those same directories beneath the remote user's home. POSIX
hosts need standard `sh`, `find`, `stat` (GNU or BSD), `tail`, `head`, and `base64`;
Windows hosts use Windows PowerShell and .NET. No Clankie or Node installation is
required remotely. Custom harness history roots are not supported yet.

Owners configure `agentHosts.connections` through `clankie agents hosts`; a host
has `id`, `ssh` (an OpenSSH destination or configured alias), and `shell`
(`posix` or `powershell`). Authentication, ports and jump hosts belong in the
owner's SSH configuration. Calls use batch authentication and normal host-key
verification, with a 10-second connection and 30-second command deadline. The
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
