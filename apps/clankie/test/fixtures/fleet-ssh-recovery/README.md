The integration fixture runs actual child processes through the production
`execFile` and `spawn` paths. Its `ssh` executable refuses every destination
except `fixture.invalid`, records argv, and captures a simulated login PATH
per ControlPath. Its PowerShell-shaped child decodes the production UTF-16LE
`-EncodedCommand`, resolves the program against that captured PATH, and launches
another real executable. No remote machine or real SSH master is contacted.
POSIX commands cross a real `/bin/sh` boundary with that captured PATH, retaining
only `/bin` for the shell itself; argument and working-directory quoting is
therefore checked by the actual shell parser.

`missing-command.clixml` represents Windows PowerShell 5.1's stderr serialization
shape, including the Get-Command error reported on VUH-1658. It is a constructed
fixture, not a capture of James's PC. PowerShell itself and real OpenSSH are not
executed by this test; it proves the command/error boundary and link consumer.

Missing outer-launch programs emit the production wrapper's unique marker and
exit 127. The persistent `missing-clixml` mode retains noisy progress framing to
prove error decoding even with upstream records. The native dependency-failure
mode emits the same diagnostic after recording a mutation, without the marker;
the transport must surface the error without replaying that program.

The successful relay mode uses actual loopback TCP forwarding and nonce-bound
framed messages through child stdio. One resident relay keeps its published
port; there is no scheduled replacement. An isolated control file stops only
that fixture relay to verify a real outage revokes its lifetime and the link
recovers on a fresh port. Program lookup against a refreshed machine and user
PATH happens inside the real Windows relay, which this fixture does not run.
