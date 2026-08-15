# docs/adr/0086-clankie-holds-a-shell.md

The captain gets `bash` and `read_file`, executed
by the body-owning host under a macOS Seatbelt
`ShellSandbox`: reads reach the whole host,
writes are confined to one scratchpad, no network
egress, no inherited environment. Splits ADR
0027's "tool-less captain" into its load-bearing
half (he cannot change the tree he is judged
against) and the half that was incidental.

Read for the probed boundary table (writes
outside → SIGKILL, `curl` → killed, `nohup`
children confined, launchd unreachable; Apple
Events unverified) and the standing caveats:
reads include on-disk credentials by explicit
operator choice; no-egress is what keeps
read-anything from being exfiltrate-anything;
delegation to workers, not the sandbox, is the
real path to unconfined execution. macOS only —
fails closed elsewhere.
