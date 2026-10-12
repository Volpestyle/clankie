# VUH-2135: finite SSH transport and definite failed-send receipts

Tested source: `77a2942602d5e4c15f06a64205698c1db329bb5f` (base `447a0ea56388255ca002bcb8d71d505823df8fe7`).

Large finite Windows wrappers now travel as one base64 line over SSH stdin;
POSIX uses `sh -s`. The SSH control request stays below 4,096 bytes. A per-command
remote-entry nonce prevents child stderr that resembles an SSH failure from
being treated as not-sent. Proven mux rejection or bootstrap launch failure
returns undelivered and releases only its exact dispatch fence; resets and lost
native acknowledgments remain uncertain. Windows' login shell may map the
bootstrap exit 127 to 1; the unique launch marker still proves no child started.

## Checks

- Formatter and lint passed on explicit touched files.
- Five focused test files: **80 passed, 1 skipped**. The skipped test is the
  unchanged VUH-2143 opt-in native catalog proof.
- Real PC (`volpe@supedupsilly`) read-only proof: three 32,768-character Unicode
  hash round trips and a 20,000-character Node argv round trip, through the same
  owned multiplexed SSH master. A nonexistent-cwd bootstrap returns not-sent.
  Only this proof's own SSH master was closed.
- Native child-process fixture proves a pre-channel rejection launches no remote
  program and allows a deliberate follow-up across a receipt-store restart.
  A dispatched child printing `mm_send_fd` keeps an uncertain receipt.
- Integrator supplies the required exact-tree root landing gate.

## Open acceptance gaps

This is the transport/receipt slice, not completed VUH-2135 acceptance. No real PC
worker seat received a brief. A coordinated idle seat or isolated proof pane is
still needed; existing KH2 panes were untouched. `message_clankie` remains held
by original receipt `78763e79-de73-4b33-a4f5-cfc54c4817c5`, so the coordination
request and progress are retained on the issue.

A separate real-PC probe confirmed a full 32,768-character child argument fails
Windows `Process.Start` with “The filename or extension is too long”, after SSH
succeeds. It now reports definitive not-sent. Full-size standalone CLI delivery
still needs a staged payload pointer or native input route; a shell hash proof
does not establish `message_seat` native acceptance.

The raw logs, boundary probe and tested source provenance are in the evidence
archive manifest beside this README.
