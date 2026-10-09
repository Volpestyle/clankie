# VUH-1980: recover the original remote lead bridge

The old standalone bridge aborted its shared controller after any HTTP 403.
A temporary native-proof refusal therefore killed its tools/channel, and the
transcript hook masked that refusal as AbortError. Service restart also erased
all in-memory delegations. Fixture proof reproduced permanent disconnection.
The exact cause of the live 19:27 native-observation refusal is not established.

The bridge now keeps its stdio connection through temporary refusal and transport
loss, reconnecting the idle MCP upstream and channel without replaying effects.
Only explicit revocation aborts it permanently. Private, bounded service records
contain bearer hashes and the first complete host proof, never bearer tokens.
Fresh policy and exact process/pane/native-session/chat evidence are required on
every request, including recovery. Revocation is atomic and fsynced before success.
Unproved launches, unreadable records, exited and replaced heads cannot recover.

The real Node bundle/stdio MCP, loopback HTTP and filesystem fixture covers
TCP stream loss without restart, transient native-proof loss, hook diagnostics,
idle restart catalog notification,
reconnecting/current status, wrong pane/session/chat and process replacement/exit,
permanent revocation across restart, and absence of raw tokens in records. Native
host observation is a fixture boundary; no PC is contacted. Retained failed runs
include the reproduced bug and fixture corrections before the passing checks.
Raw logs, resource samples and root receipts are archived from
`artifacts/vuh-1980-remote-lead-reconnect` and linked on the issue.

The owner deploys and performs live PC proof. Legacy heads run the old artifact
and have no saved bearer hash/original lifetime proof. One owner-controlled new
launch must load the fixed artifact after deployment; subsequent loss/restart
proof needs no relaunch. No PC state, credentials, panes or runtime were changed.
